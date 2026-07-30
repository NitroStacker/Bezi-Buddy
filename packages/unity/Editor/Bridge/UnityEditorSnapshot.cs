using System.Diagnostics;
using System.IO;
using System.Linq;
using Bezi.Remote.Editor.Protocol;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace Bezi.Remote.Editor.Bridge
{
    internal static class UnityEditorSnapshot
    {
        internal static RegisterMessage Registration(string instanceId)
        {
            return new RegisterMessage
            {
                instanceId = instanceId,
                processId = Process.GetCurrentProcess().Id,
                projectName = Path.GetFileName(Path.GetDirectoryName(Application.dataPath)),
                projectPath = Path.GetDirectoryName(Application.dataPath),
                unityVersion = Application.unityVersion,
                openScenes = OpenScenePaths(),
                playing = EditorApplication.isPlaying,
                paused = EditorApplication.isPaused,
                compiling = EditorApplication.isCompiling
            };
        }

        internal static StatusMessage Status(string instanceId)
        {
            return new StatusMessage
            {
                instanceId = instanceId,
                openScenes = OpenScenePaths(),
                playing = EditorApplication.isPlaying,
                paused = EditorApplication.isPaused,
                compiling = EditorApplication.isCompiling
            };
        }

        private static string[] OpenScenePaths()
        {
            return Enumerable.Range(0, EditorSceneManager.sceneCount)
                .Select(EditorSceneManager.GetSceneAt)
                .Where(scene => scene.IsValid())
                .Select(scene => string.IsNullOrEmpty(scene.path) ? scene.name : scene.path)
                .ToArray();
        }
    }
}

