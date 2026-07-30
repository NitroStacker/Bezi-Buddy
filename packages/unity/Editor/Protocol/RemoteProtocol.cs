using System;

namespace Bezi.Remote.Editor.Protocol
{
    internal static class RemoteProtocol
    {
        internal const int Version = 1;
        internal const int MaxMessageBytes = 4 * 1024 * 1024;
        internal const string PipeName = "bezi-remote-unity-v1";
    }

    [Serializable]
    internal sealed class RegisterMessage
    {
        public string type = "register";
        public int protocolVersion = RemoteProtocol.Version;
        public string instanceId;
        public int processId;
        public string projectName;
        public string projectPath;
        public string unityVersion;
        public string[] openScenes;
        public bool playing;
        public bool paused;
        public bool compiling;
    }

    [Serializable]
    internal sealed class StatusMessage
    {
        public string type = "status";
        public string instanceId;
        public string[] openScenes;
        public bool playing;
        public bool paused;
        public bool compiling;
    }

    [Serializable]
    internal sealed class CommandEnvelope
    {
        public string type;
        public int protocolVersion;
        public string instanceId;
        public string requestId;
        public string action;
        public string bodyJson;
    }

    [Serializable]
    internal sealed class ResultEnvelope
    {
        public string type = "result";
        public int protocolVersion = RemoteProtocol.Version;
        public string instanceId;
        public string requestId;
        public bool success;
        public string bodyJson;
        public string errorCode;
        public string message;
    }

    [Serializable]
    internal sealed class TargetRequest
    {
        public string targetId;
    }

    [Serializable]
    internal sealed class PlayRequest
    {
        public string operation;
    }

    [Serializable]
    internal sealed class ApplyPropertyRequest
    {
        public string targetId;
        public string propertyPath;
        public RemoteValue value;
        public int expectedRevision;
        public string idempotencyKey;
    }

    [Serializable]
    internal sealed class RemoteValue
    {
        public string kind;
        public bool boolValue;
        public long intValue;
        public double numberValue;
        public string stringValue;
        public float[] components;
        public string objectId;
    }

    [Serializable]
    internal sealed class HierarchySnapshot
    {
        public HierarchyNode[] nodes;
        public string[] selectedIds;
    }

    [Serializable]
    internal sealed class HierarchyNode
    {
        public string id;
        public string parentId;
        public string name;
        public int depth;
        public bool active;
        public int childCount;
        public string scene;
    }

    [Serializable]
    internal sealed class InspectorSnapshot
    {
        public string targetId;
        public string name;
        public string typeName;
        public int revision;
        public RemoteProperty[] properties;
        public ComponentSnapshot[] components;
    }

    [Serializable]
    internal sealed class ComponentSnapshot
    {
        public string targetId;
        public string name;
        public string typeName;
        public int revision;
        public RemoteProperty[] properties;
    }

    [Serializable]
    internal sealed class RemoteProperty
    {
        public string path;
        public string displayName;
        public string kind;
        public bool readOnly;
        public RemoteValue value;
        public string[] enumOptions;
    }

    [Serializable]
    internal sealed class AssetSnapshot
    {
        public AssetNode[] assets;
    }

    [Serializable]
    internal sealed class AssetNode
    {
        public string id;
        public string name;
        public string typeName;
        public string path;
    }

    [Serializable]
    internal sealed class ApplyPropertyResult
    {
        public string targetId;
        public string propertyPath;
        public int revision;
        public RemoteValue value;
        public bool sceneDirty;
        public bool assetSaved;
    }
}
