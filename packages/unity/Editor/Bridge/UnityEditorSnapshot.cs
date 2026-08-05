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
                compiling = EditorApplication.isCompiling,
                captureViews = CaptureViews()
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
                compiling = EditorApplication.isCompiling,
                captureViews = CaptureViews()
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

        private static CaptureView[] CaptureViews()
        {
            return Resources.FindObjectsOfTypeAll<EditorWindow>()
                .Select(window =>
                {
                    var fullName = window.GetType().FullName;
                    var kind = fullName == "UnityEditor.GameView"
                        ? "game"
                        : window is SceneView ? "scene" : null;
                    if (kind == null)
                    {
                        return null;
                    }
                    var position = window.position;
                    return new CaptureView
                    {
                        kind = kind,
                        title = window.titleContent != null ? window.titleContent.text : kind,
                        x = position.x,
                        y = position.y,
                        width = position.width,
                        height = position.height,
                        pixelsPerPoint = EditorGUIUtility.pixelsPerPoint
                    };
                })
                .Where(view => view != null && view.width > 1f && view.height > 1f)
                .OrderBy(view => view.kind == "game" ? 0 : 1)
                .ToArray();
        }
    }
}
