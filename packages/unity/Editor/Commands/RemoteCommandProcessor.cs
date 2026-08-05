using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Bezi.Remote.Editor.Protocol;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;
using Object = UnityEngine.Object;

namespace Bezi.Remote.Editor.Commands
{
    internal sealed class RemoteCommandProcessor
    {
        private const int IdempotencyLimit = 256;
        private readonly string _instanceId;
        private readonly Dictionary<string, ResultEnvelope> _idempotentResults = new();
        private readonly Queue<string> _idempotencyOrder = new();

        internal RemoteCommandProcessor(string instanceId)
        {
            _instanceId = instanceId;
        }

        internal ResultEnvelope Execute(CommandEnvelope command)
        {
            if (command == null ||
                string.IsNullOrWhiteSpace(command.requestId) ||
                string.IsNullOrWhiteSpace(command.action))
            {
                return Failure(command?.requestId, "invalid_command", "The command is incomplete.");
            }

            try
            {
                return command.action switch
                {
                    "hierarchy.snapshot" => Success(
                        command.requestId,
                        JsonUtility.ToJson(HierarchyService.Capture())),
                    "assets.snapshot" => Success(
                        command.requestId,
                        JsonUtility.ToJson(AssetService.Capture())),
                    "selection.set" => ExecuteSelect(command),
                    "inspector.snapshot" => ExecuteInspect(command),
                    "property.apply" => ExecuteApply(command),
                    "capture.view.activate" => ExecuteActivateCaptureView(command),
                    "play.control" => ExecutePlay(command),
                    _ => Failure(
                        command.requestId,
                        "unsupported_action",
                        $"Unity action '{command.action}' is not supported.")
                };
            }
            catch (CommandException exception)
            {
                return Failure(command.requestId, exception.Code, exception.Message);
            }
            catch (Exception exception)
            {
                return Failure(command.requestId, "unity_exception", exception.Message);
            }
        }

        private ResultEnvelope ExecuteSelect(CommandEnvelope command)
        {
            var request = Parse<TargetRequest>(command.bodyJson);
            var target = TargetResolver.Resolve(request.targetId);
            Selection.activeObject = target;
            EditorGUIUtility.PingObject(target);
            return Success(command.requestId, JsonUtility.ToJson(new TargetRequest
            {
                targetId = TargetResolver.Id(target)
            }));
        }

        private ResultEnvelope ExecuteInspect(CommandEnvelope command)
        {
            var request = Parse<TargetRequest>(command.bodyJson);
            var target = TargetResolver.Resolve(request.targetId);
            return Success(
                command.requestId,
                JsonUtility.ToJson(SerializedPropertyService.Inspect(target)));
        }

        private ResultEnvelope ExecuteApply(CommandEnvelope command)
        {
            var request = Parse<ApplyPropertyRequest>(command.bodyJson);
            if (string.IsNullOrWhiteSpace(request.idempotencyKey))
            {
                throw new CommandException(
                    "idempotency_required",
                    "Property writes require an idempotency key.");
            }

            if (_idempotentResults.TryGetValue(request.idempotencyKey, out var existing))
            {
                return existing;
            }

            var target = TargetResolver.Resolve(request.targetId);
            var applied = SerializedPropertyService.Apply(target, request);
            var result = Success(command.requestId, JsonUtility.ToJson(applied));
            Remember(request.idempotencyKey, result);
            return result;
        }

        private ResultEnvelope ExecutePlay(CommandEnvelope command)
        {
            if (EditorApplication.isCompiling || EditorApplication.isUpdating)
            {
                throw new CommandException(
                    "editor_busy",
                    "Play controls are unavailable while Unity is compiling or importing.");
            }

            var request = Parse<PlayRequest>(command.bodyJson);
            switch (request.operation)
            {
                case "play":
                    EditorApplication.isPlaying = true;
                    break;
                case "stop":
                    EditorApplication.isPlaying = false;
                    break;
                case "pause":
                    if (!EditorApplication.isPlaying)
                    {
                        throw new CommandException(
                            "not_playing",
                            "Unity must be in Play Mode before it can be paused.");
                    }
                    EditorApplication.isPaused = true;
                    break;
                case "resume":
                    EditorApplication.isPaused = false;
                    break;
                case "step":
                    if (!EditorApplication.isPlaying)
                    {
                        throw new CommandException(
                            "not_playing",
                            "Unity must be in Play Mode before stepping a frame.");
                    }
                    EditorApplication.Step();
                    break;
                default:
                    throw new CommandException(
                        "invalid_play_operation",
                        $"Unknown Play operation '{request.operation}'.");
            }

            return Success(command.requestId, JsonUtility.ToJson(new StatusResult
            {
                playing = EditorApplication.isPlaying,
                paused = EditorApplication.isPaused
            }));
        }

        private ResultEnvelope ExecuteActivateCaptureView(CommandEnvelope command)
        {
            var request = Parse<CaptureViewRequest>(command.bodyJson);
            var expectedType = request.kind == "game"
                ? "UnityEditor.GameView"
                : request.kind == "scene" ? typeof(SceneView).FullName : null;
            if (expectedType == null)
            {
                throw new CommandException("invalid_view", "Capture view must be 'game' or 'scene'.");
            }
            var window = Resources.FindObjectsOfTypeAll<EditorWindow>()
                .FirstOrDefault(candidate => candidate.GetType().FullName == expectedType);
            if (window == null)
            {
                throw new CommandException(
                    "view_unavailable",
                    $"The Unity {request.kind} view is not open.");
            }
            window.Focus();
            window.Repaint();
            return Success(command.requestId, JsonUtility.ToJson(request));
        }

        private void Remember(string key, ResultEnvelope result)
        {
            _idempotentResults[key] = result;
            _idempotencyOrder.Enqueue(key);
            while (_idempotencyOrder.Count > IdempotencyLimit)
            {
                _idempotentResults.Remove(_idempotencyOrder.Dequeue());
            }
        }

        private ResultEnvelope Success(string requestId, string bodyJson)
        {
            return new ResultEnvelope
            {
                instanceId = _instanceId,
                requestId = requestId,
                success = true,
                bodyJson = bodyJson
            };
        }

        private ResultEnvelope Failure(string requestId, string code, string message)
        {
            return new ResultEnvelope
            {
                instanceId = _instanceId,
                requestId = requestId,
                success = false,
                errorCode = code,
                message = message
            };
        }

        private static T Parse<T>(string json) where T : class
        {
            if (string.IsNullOrWhiteSpace(json))
            {
                throw new CommandException("invalid_body", "The command body is required.");
            }

            var value = JsonUtility.FromJson<T>(json);
            return value ?? throw new CommandException(
                "invalid_body",
                "The command body could not be parsed.");
        }

        [Serializable]
        private sealed class StatusResult
        {
            public bool playing;
            public bool paused;
        }
    }

    internal sealed class CommandException : Exception
    {
        internal string Code { get; }

        internal CommandException(string code, string message) : base(message)
        {
            Code = code;
        }
    }

    internal static class TargetResolver
    {
        internal static Object Resolve(string value)
        {
            if (string.IsNullOrWhiteSpace(value) ||
                !GlobalObjectId.TryParse(value, out var id))
            {
                throw new CommandException("invalid_target", "The Unity target ID is invalid.");
            }

            var target = GlobalObjectId.GlobalObjectIdentifierToObjectSlow(id);
            return target != null
                ? target
                : throw new CommandException("target_missing", "The Unity target no longer exists.");
        }

        internal static string Id(Object target)
        {
            return GlobalObjectId.GetGlobalObjectIdSlow(target).ToString();
        }
    }

    internal static class HierarchyService
    {
        internal static HierarchySnapshot Capture()
        {
            var nodes = new List<HierarchyNode>();
            for (var sceneIndex = 0; sceneIndex < SceneManager.sceneCount; sceneIndex++)
            {
                var scene = SceneManager.GetSceneAt(sceneIndex);
                if (!scene.IsValid())
                {
                    continue;
                }

                foreach (var root in scene.GetRootGameObjects())
                {
                    Add(root.transform, null, scene, 0, nodes);
                }
            }

            return new HierarchySnapshot
            {
                nodes = nodes.ToArray(),
                selectedIds = Selection.objects
                    .Where(value => value != null)
                    .Select(TargetResolver.Id)
                    .ToArray()
            };
        }

        private static void Add(
            Transform transform,
            string parentId,
            Scene scene,
            int depth,
            ICollection<HierarchyNode> nodes)
        {
            var id = TargetResolver.Id(transform.gameObject);
            nodes.Add(new HierarchyNode
            {
                id = id,
                parentId = parentId,
                name = transform.name,
                depth = depth,
                active = transform.gameObject.activeInHierarchy,
                childCount = transform.childCount,
                scene = string.IsNullOrEmpty(scene.path) ? scene.name : scene.path
            });

            for (var index = 0; index < transform.childCount; index++)
            {
                Add(transform.GetChild(index), id, scene, depth + 1, nodes);
            }
        }
    }

    internal static class AssetService
    {
        internal static AssetSnapshot Capture()
        {
            var assets = AssetDatabase.FindAssets(string.Empty, new[] { "Assets" })
                .Select(AssetDatabase.GUIDToAssetPath)
                .Where(path => !string.IsNullOrWhiteSpace(path))
                .Where(path => !AssetDatabase.IsValidFolder(path))
                .Distinct()
                .OrderBy(path => path, StringComparer.OrdinalIgnoreCase)
                .Take(4000)
                .Select(path => new
                {
                    Path = path,
                    Asset = AssetDatabase.LoadMainAssetAtPath(path)
                })
                .Where(entry => entry.Asset != null)
                .Select(entry => new AssetNode
                {
                    id = TargetResolver.Id(entry.Asset),
                    name = string.IsNullOrWhiteSpace(entry.Asset.name)
                        ? Path.GetFileNameWithoutExtension(entry.Path)
                        : entry.Asset.name,
                    typeName = entry.Asset.GetType().FullName,
                    path = entry.Path
                })
                .ToArray();

            return new AssetSnapshot { assets = assets };
        }
    }

    internal static class SerializedPropertyService
    {
        internal static InspectorSnapshot Inspect(Object target)
        {
            var components = target is GameObject gameObject
                ? gameObject.GetComponents<Component>()
                    .Where(component => component != null)
                    .Select(SnapshotComponent)
                    .ToArray()
                : Array.Empty<ComponentSnapshot>();

            var snapshot = Snapshot(target);
            return new InspectorSnapshot
            {
                targetId = snapshot.targetId,
                name = snapshot.name,
                typeName = snapshot.typeName,
                revision = snapshot.revision,
                properties = snapshot.properties,
                components = components
            };
        }

        private static ComponentSnapshot SnapshotComponent(Object target)
        {
            return Snapshot(target);
        }

        private static ComponentSnapshot Snapshot(Object target)
        {
            var serialized = new SerializedObject(target);
            serialized.UpdateIfRequiredOrScript();
            var properties = new List<RemoteProperty>();
            var iterator = serialized.GetIterator();
            var enterChildren = true;
            while (iterator.NextVisible(enterChildren))
            {
                enterChildren = false;
                properties.Add(ToRemoteProperty(iterator));
            }

            return new ComponentSnapshot
            {
                targetId = TargetResolver.Id(target),
                name = target.name,
                typeName = target.GetType().FullName,
                revision = Revision(target),
                properties = properties.ToArray()
            };
        }

        internal static ApplyPropertyResult Apply(
            Object target,
            ApplyPropertyRequest request)
        {
            if (EditorApplication.isCompiling || EditorApplication.isUpdating)
            {
                throw new CommandException(
                    "editor_busy",
                    "Unity is compiling or importing assets.");
            }
            if (EditorApplication.isPlaying && EditorUtility.IsPersistent(target))
            {
                throw new CommandException(
                    "play_mode_asset_write",
                    "Persistent assets cannot be edited during Play Mode.");
            }

            var currentRevision = Revision(target);
            if (currentRevision != request.expectedRevision)
            {
                throw new CommandException(
                    "revision_conflict",
                    $"Expected revision {request.expectedRevision}, current revision is {currentRevision}.");
            }

            var serialized = new SerializedObject(target);
            serialized.UpdateIfRequiredOrScript();
            var property = serialized.FindProperty(request.propertyPath);
            if (property == null)
            {
                throw new CommandException(
                    "property_missing",
                    "The serialized property no longer exists.");
            }
            if (IsReadOnly(property))
            {
                throw new CommandException(
                    "property_read_only",
                    "This property type is read-only over Bezi Remote.");
            }

            Undo.IncrementCurrentGroup();
            var undoGroup = Undo.GetCurrentGroup();
            Undo.SetCurrentGroupName($"Bezi Remote: {property.displayName}");
            Undo.RecordObject(target, $"Bezi Remote: {property.displayName}");
            SetValue(property, request.value);
            if (!serialized.ApplyModifiedProperties())
            {
                Undo.RevertAllDownToGroup(undoGroup);
                throw new CommandException("no_change", "Unity did not apply a property change.");
            }

            EditorUtility.SetDirty(target);
            var assetSaved = EditorUtility.IsPersistent(target);
            var sceneDirty = false;
            if (assetSaved)
            {
                AssetDatabase.SaveAssetIfDirty(target);
            }
            else if (TryGetScene(target, out var scene))
            {
                EditorSceneManager.MarkSceneDirty(scene);
                sceneDirty = true;
            }
            Undo.CollapseUndoOperations(undoGroup);

            serialized.UpdateIfRequiredOrScript();
            property = serialized.FindProperty(request.propertyPath);
            return new ApplyPropertyResult
            {
                targetId = TargetResolver.Id(target),
                propertyPath = request.propertyPath,
                revision = Revision(target),
                value = property != null ? ReadValue(property) : request.value,
                sceneDirty = sceneDirty,
                assetSaved = assetSaved
            };
        }

        private static RemoteProperty ToRemoteProperty(SerializedProperty property)
        {
            return new RemoteProperty
            {
                path = property.propertyPath,
                displayName = property.displayName,
                kind = Kind(property),
                readOnly = IsReadOnly(property),
                value = ReadValue(property),
                enumOptions = property.propertyType == SerializedPropertyType.Enum
                    ? property.enumDisplayNames
                    : Array.Empty<string>(),
                referenceType = property.propertyType == SerializedPropertyType.ObjectReference
                    ? property.type
                    : null
            };
        }

        private static bool IsReadOnly(SerializedProperty property)
        {
            return property.propertyPath == "m_Script" ||
                   property.propertyType == SerializedPropertyType.Generic ||
                   property.propertyType == SerializedPropertyType.ManagedReference ||
                   (property.isArray && property.propertyType != SerializedPropertyType.String);
        }

        private static string Kind(SerializedProperty property)
        {
            return property.propertyType switch
            {
                SerializedPropertyType.Boolean => "boolean",
                SerializedPropertyType.Integer => "integer",
                SerializedPropertyType.Float => "number",
                SerializedPropertyType.String => "string",
                SerializedPropertyType.Enum => "enum",
                SerializedPropertyType.Color => "color",
                SerializedPropertyType.Vector2 => "vector2",
                SerializedPropertyType.Vector3 => "vector3",
                SerializedPropertyType.Vector4 => "vector4",
                SerializedPropertyType.Vector2Int => "vector2Int",
                SerializedPropertyType.Vector3Int => "vector3Int",
                SerializedPropertyType.Rect => "rect",
                SerializedPropertyType.RectInt => "rectInt",
                SerializedPropertyType.Bounds => "bounds",
                SerializedPropertyType.BoundsInt => "boundsInt",
                SerializedPropertyType.Quaternion => "quaternion",
                SerializedPropertyType.ObjectReference => "objectReference",
                _ => property.propertyType.ToString()
            };
        }

        private static RemoteValue ReadValue(SerializedProperty property)
        {
            var value = new RemoteValue { kind = Kind(property), components = Array.Empty<float>() };
            switch (property.propertyType)
            {
                case SerializedPropertyType.Boolean:
                    value.boolValue = property.boolValue;
                    break;
                case SerializedPropertyType.Integer:
                    value.intValue = property.longValue;
                    break;
                case SerializedPropertyType.Float:
                    value.numberValue = property.doubleValue;
                    break;
                case SerializedPropertyType.String:
                    value.stringValue = property.stringValue;
                    break;
                case SerializedPropertyType.Enum:
                    value.intValue = property.enumValueIndex;
                    value.stringValue = property.enumDisplayNames.ElementAtOrDefault(property.enumValueIndex);
                    break;
                case SerializedPropertyType.Color:
                    var color = property.colorValue;
                    value.components = new[] { color.r, color.g, color.b, color.a };
                    break;
                case SerializedPropertyType.Vector2:
                    var vector2 = property.vector2Value;
                    value.components = new[] { vector2.x, vector2.y };
                    break;
                case SerializedPropertyType.Vector3:
                    var vector3 = property.vector3Value;
                    value.components = new[] { vector3.x, vector3.y, vector3.z };
                    break;
                case SerializedPropertyType.Vector4:
                    var vector4 = property.vector4Value;
                    value.components = new[] { vector4.x, vector4.y, vector4.z, vector4.w };
                    break;
                case SerializedPropertyType.Vector2Int:
                    var vector2Int = property.vector2IntValue;
                    value.components = new[] { (float)vector2Int.x, vector2Int.y };
                    break;
                case SerializedPropertyType.Vector3Int:
                    var vector3Int = property.vector3IntValue;
                    value.components = new[]
                    {
                        (float)vector3Int.x, vector3Int.y, vector3Int.z
                    };
                    break;
                case SerializedPropertyType.ObjectReference:
                    value.objectId = property.objectReferenceValue != null
                        ? TargetResolver.Id(property.objectReferenceValue)
                        : string.Empty;
                    break;
                case SerializedPropertyType.Rect:
                    var rect = property.rectValue;
                    value.components = new[] { rect.x, rect.y, rect.width, rect.height };
                    break;
                case SerializedPropertyType.RectInt:
                    var rectInt = property.rectIntValue;
                    value.components = new[]
                    {
                        (float)rectInt.x, rectInt.y, rectInt.width, rectInt.height
                    };
                    break;
                case SerializedPropertyType.Bounds:
                    var bounds = property.boundsValue;
                    value.components = new[]
                    {
                        bounds.center.x, bounds.center.y, bounds.center.z,
                        bounds.size.x, bounds.size.y, bounds.size.z
                    };
                    break;
                case SerializedPropertyType.BoundsInt:
                    var boundsInt = property.boundsIntValue;
                    value.components = new[]
                    {
                        (float)boundsInt.position.x,
                        boundsInt.position.y,
                        boundsInt.position.z,
                        boundsInt.size.x,
                        boundsInt.size.y,
                        boundsInt.size.z
                    };
                    break;
                case SerializedPropertyType.Quaternion:
                    var quaternion = property.quaternionValue;
                    value.components = new[] { quaternion.x, quaternion.y, quaternion.z, quaternion.w };
                    break;
            }
            return value;
        }

        private static void SetValue(SerializedProperty property, RemoteValue value)
        {
            if (value == null)
            {
                throw new CommandException("invalid_value", "A typed property value is required.");
            }

            switch (property.propertyType)
            {
                case SerializedPropertyType.Boolean:
                    property.boolValue = value.boolValue;
                    break;
                case SerializedPropertyType.Integer:
                    property.longValue = value.intValue;
                    break;
                case SerializedPropertyType.Float:
                    property.doubleValue = value.numberValue;
                    break;
                case SerializedPropertyType.String:
                    property.stringValue = value.stringValue ?? string.Empty;
                    break;
                case SerializedPropertyType.Enum:
                    property.enumValueIndex = checked((int)value.intValue);
                    break;
                case SerializedPropertyType.Color:
                    RequireComponents(value, 4);
                    property.colorValue = new Color(
                        value.components[0], value.components[1],
                        value.components[2], value.components[3]);
                    break;
                case SerializedPropertyType.Vector2:
                    RequireComponents(value, 2);
                    property.vector2Value = new Vector2(value.components[0], value.components[1]);
                    break;
                case SerializedPropertyType.Vector3:
                    RequireComponents(value, 3);
                    property.vector3Value = new Vector3(
                        value.components[0], value.components[1], value.components[2]);
                    break;
                case SerializedPropertyType.Vector4:
                    RequireComponents(value, 4);
                    property.vector4Value = new Vector4(
                        value.components[0], value.components[1],
                        value.components[2], value.components[3]);
                    break;
                case SerializedPropertyType.Vector2Int:
                    RequireComponents(value, 2);
                    property.vector2IntValue = new Vector2Int(
                        Mathf.RoundToInt(value.components[0]),
                        Mathf.RoundToInt(value.components[1]));
                    break;
                case SerializedPropertyType.Vector3Int:
                    RequireComponents(value, 3);
                    property.vector3IntValue = new Vector3Int(
                        Mathf.RoundToInt(value.components[0]),
                        Mathf.RoundToInt(value.components[1]),
                        Mathf.RoundToInt(value.components[2]));
                    break;
                case SerializedPropertyType.ObjectReference:
                    property.objectReferenceValue = string.IsNullOrWhiteSpace(value.objectId)
                        ? null
                        : TargetResolver.Resolve(value.objectId);
                    break;
                case SerializedPropertyType.Rect:
                    RequireComponents(value, 4);
                    property.rectValue = new Rect(
                        value.components[0], value.components[1],
                        value.components[2], value.components[3]);
                    break;
                case SerializedPropertyType.RectInt:
                    RequireComponents(value, 4);
                    property.rectIntValue = new RectInt(
                        Mathf.RoundToInt(value.components[0]),
                        Mathf.RoundToInt(value.components[1]),
                        Mathf.RoundToInt(value.components[2]),
                        Mathf.RoundToInt(value.components[3]));
                    break;
                case SerializedPropertyType.Bounds:
                    RequireComponents(value, 6);
                    property.boundsValue = new Bounds(
                        new Vector3(value.components[0], value.components[1], value.components[2]),
                        new Vector3(value.components[3], value.components[4], value.components[5]));
                    break;
                case SerializedPropertyType.BoundsInt:
                    RequireComponents(value, 6);
                    property.boundsIntValue = new BoundsInt(
                        new Vector3Int(
                            Mathf.RoundToInt(value.components[0]),
                            Mathf.RoundToInt(value.components[1]),
                            Mathf.RoundToInt(value.components[2])),
                        new Vector3Int(
                            Mathf.RoundToInt(value.components[3]),
                            Mathf.RoundToInt(value.components[4]),
                            Mathf.RoundToInt(value.components[5])));
                    break;
                case SerializedPropertyType.Quaternion:
                    RequireComponents(value, 4);
                    property.quaternionValue = new Quaternion(
                        value.components[0], value.components[1],
                        value.components[2], value.components[3]);
                    break;
                default:
                    throw new CommandException(
                        "property_read_only",
                        $"Property type {property.propertyType} is not writable.");
            }
        }

        private static void RequireComponents(RemoteValue value, int count)
        {
            if (value.components == null || value.components.Length != count)
            {
                throw new CommandException(
                    "invalid_value",
                    $"The property value requires exactly {count} components.");
            }
        }

        private static int Revision(Object target)
        {
            var json = EditorJsonUtility.ToJson(target);
            return Hash128.Compute(json).GetHashCode() & int.MaxValue;
        }

        private static bool TryGetScene(Object target, out Scene scene)
        {
            if (target is GameObject gameObject)
            {
                scene = gameObject.scene;
                return scene.IsValid();
            }
            if (target is Component component)
            {
                scene = component.gameObject.scene;
                return scene.IsValid();
            }
            scene = default;
            return false;
        }
    }
}
