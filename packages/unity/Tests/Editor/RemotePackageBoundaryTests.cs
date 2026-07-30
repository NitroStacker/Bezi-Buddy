using NUnit.Framework;
using Bezi.Remote.Editor.Commands;
using Bezi.Remote.Editor.Protocol;

namespace Bezi.Remote.Editor.Tests
{
    public sealed class RemotePackageBoundaryTests
    {
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
    }
}
