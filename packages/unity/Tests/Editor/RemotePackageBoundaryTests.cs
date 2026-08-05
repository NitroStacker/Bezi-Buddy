using NUnit.Framework;
using Bezi.Remote.Editor.Commands;
using Bezi.Remote.Editor.Protocol;
using UnityEditor;
using UnityEngine;

namespace Bezi.Remote.Editor.Tests
{
    public sealed class RemotePackageBoundaryTests
    {
        private sealed class ReferenceHolder : ScriptableObject
        {
            public string text = "Before";
            public Material fontLikeAsset;
        }

        [Test]
        public void EditorAssembly_IsNotCompiledIntoPlayers()
        {
            var assembly = typeof(RemotePackageBoundaryTests).Assembly;
            Assert.That(assembly.GetName().Name, Does.Contain("Editor"));
        }

        [Test]
        public void IncompleteCommand_IsRejectedWithoutThrowing()
        {
            var processor = new RemoteCommandProcessor("test-instance");

            var result = processor.Execute(new CommandEnvelope());

            Assert.That(result.success, Is.False);
            Assert.That(result.errorCode, Is.EqualTo("invalid_command"));
        }

        [Test]
        public void UnknownCommand_ReturnsCapabilityError()
        {
            var processor = new RemoteCommandProcessor("test-instance");

            var result = processor.Execute(new CommandEnvelope
            {
                requestId = "request-1",
                action = "editor.internal.unsupported",
                bodyJson = "{}"
            });

            Assert.That(result.success, Is.False);
            Assert.That(result.errorCode, Is.EqualTo("unsupported_action"));
        }

        [Test]
        public void AssetSnapshot_IncludesGeneralProjectAssetsForContextPins()
        {
            const string folder = "Assets/BeziRemoteContextPinTests";
            const string path = folder + "/MentionMaterial.mat";
            if (!AssetDatabase.IsValidFolder(folder))
            {
                AssetDatabase.CreateFolder("Assets", "BeziRemoteContextPinTests");
            }
            var shader = Shader.Find("Standard") ?? Shader.Find("Hidden/InternalErrorShader");
            AssetDatabase.CreateAsset(new Material(shader), path);
            try
            {
                var snapshot = AssetService.Capture();

                Assert.That(snapshot.assets, Has.Some.Matches<AssetNode>(asset =>
                    asset.path == path && asset.typeName == typeof(Material).FullName));
            }
            finally
            {
                AssetDatabase.DeleteAsset(folder);
            }
        }

        [Test]
        public void Inspector_TextAndObjectReferencesCanBeChanged()
        {
            const string folder = "Assets/BeziRemoteInspectorTests";
            const string materialPath = folder + "/InspectorMaterial.mat";
            const string holderPath = folder + "/ReferenceHolder.asset";
            if (!AssetDatabase.IsValidFolder(folder))
            {
                AssetDatabase.CreateFolder("Assets", "BeziRemoteInspectorTests");
            }
            var shader = Shader.Find("Standard") ?? Shader.Find("Hidden/InternalErrorShader");
            var material = new Material(shader);
            var holder = ScriptableObject.CreateInstance<ReferenceHolder>();
            AssetDatabase.CreateAsset(material, materialPath);
            AssetDatabase.CreateAsset(holder, holderPath);
            try
            {
                var snapshot = SerializedPropertyService.Inspect(holder);
                var textProperty = System.Array.Find(snapshot.properties, item => item.path == "text");
                var property = System.Array.Find(snapshot.properties, item => item.path == "fontLikeAsset");

                Assert.That(textProperty, Is.Not.Null);
                Assert.That(textProperty.kind, Is.EqualTo("string"));
                Assert.That(textProperty.readOnly, Is.False);
                Assert.That(property, Is.Not.Null);
                Assert.That(property.kind, Is.EqualTo("objectReference"));
                Assert.That(property.readOnly, Is.False);
                Assert.That(property.referenceType, Does.Contain("Material"));

                SerializedPropertyService.Apply(holder, new ApplyPropertyRequest
                {
                    targetId = snapshot.targetId,
                    propertyPath = textProperty.path,
                    expectedRevision = snapshot.revision,
                    idempotencyKey = "string-test",
                    value = new RemoteValue
                    {
                        kind = "string",
                        stringValue = "After"
                    }
                });
                Assert.That(holder.text, Is.EqualTo("After"));

                snapshot = SerializedPropertyService.Inspect(holder);
                property = System.Array.Find(snapshot.properties, item => item.path == "fontLikeAsset");
                SerializedPropertyService.Apply(holder, new ApplyPropertyRequest
                {
                    targetId = snapshot.targetId,
                    propertyPath = property.path,
                    expectedRevision = snapshot.revision,
                    idempotencyKey = "object-reference-test",
                    value = new RemoteValue
                    {
                        kind = "objectReference",
                        objectId = TargetResolver.Id(material)
                    }
                });

                Assert.That(AssetDatabase.GetAssetPath(holder.fontLikeAsset), Is.EqualTo(materialPath));
            }
            finally
            {
                AssetDatabase.DeleteAsset(folder);
            }
        }
    }
}
