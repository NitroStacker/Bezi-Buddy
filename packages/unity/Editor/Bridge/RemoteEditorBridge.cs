using System;
using System.Collections.Concurrent;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Bezi.Remote.Editor.Commands;
using Bezi.Remote.Editor.Protocol;
using UnityEditor;
using UnityEngine;

namespace Bezi.Remote.Editor.Bridge
{
    [InitializeOnLoad]
    internal static class RemoteEditorBridge
    {
        private static readonly string InstanceId = Guid.NewGuid().ToString("D");
        private static readonly ConcurrentQueue<CommandEnvelope> Commands = new();
        private static readonly ConcurrentQueue<string> Outbound = new();
        private static readonly TaskCompletionSource<string> Registration =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
        private static readonly CancellationTokenSource Lifetime = new();
        private static readonly RemoteCommandProcessor Processor = new(InstanceId);
        private static double _nextStatusAt;
        private static int _workerStarted;
        private static volatile bool _connected;
        private static string _connectionState = "Starting";

        static RemoteEditorBridge()
        {
            EditorApplication.update += Update;
            AssemblyReloadEvents.beforeAssemblyReload += Shutdown;
            EditorApplication.quitting += Shutdown;
            StartWorker();
        }

        private static void Update()
        {
            if (!Registration.Task.IsCompleted)
            {
                Registration.TrySetResult(
                    JsonUtility.ToJson(UnityEditorSnapshot.Registration(InstanceId)));
            }

            while (Commands.TryDequeue(out var command))
            {
                ResultEnvelope result;
                try
                {
                    result = Processor.Execute(command);
                }
                catch (Exception exception)
                {
                    result = new ResultEnvelope
                    {
                        instanceId = InstanceId,
                        requestId = command.requestId,
                        success = false,
                        errorCode = "unity_exception",
                        message = exception.Message
                    };
                }

                Outbound.Enqueue(JsonUtility.ToJson(result));
            }

            if (_connected && EditorApplication.timeSinceStartup >= _nextStatusAt)
            {
                _nextStatusAt = EditorApplication.timeSinceStartup + 1.0;
                Outbound.Enqueue(JsonUtility.ToJson(UnityEditorSnapshot.Status(InstanceId)));
            }
        }

        private static void StartWorker()
        {
            if (Interlocked.Exchange(ref _workerStarted, 1) != 0)
            {
                return;
            }

            _ = Task.Run(() => ConnectionLoop(Lifetime.Token), Lifetime.Token);
        }

        private static async Task ConnectionLoop(CancellationToken cancellationToken)
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                try
                {
                    using var pipe = new NamedPipeClientStream(
                        ".",
                        RemoteProtocol.PipeName,
                        PipeDirection.InOut,
                        PipeOptions.Asynchronous);
                    await pipe.ConnectAsync(1500, cancellationToken);
                    _connected = true;
                    _connectionState = "Connected";
                    await WriteMessage(
                        pipe,
                        await Registration.Task,
                        cancellationToken);

                    var readTask = ReadLoop(pipe, cancellationToken);
                    while (!cancellationToken.IsCancellationRequested)
                    {
                        if (readTask.IsCompleted)
                        {
                            await readTask;
                            break;
                        }

                        while (Outbound.TryDequeue(out var message))
                        {
                            await WriteMessage(pipe, message, cancellationToken);
                        }

                        await Task.WhenAny(
                            readTask,
                            Task.Delay(40, cancellationToken));
                    }

                    if (!readTask.IsCompleted)
                    {
                        await readTask;
                    }
                }
                catch (OperationCanceledException)
                {
                    break;
                }
                catch (Exception exception)
                {
                    _connectionState = $"{exception.GetType().Name}: {exception.Message}";
                    await Task.Delay(1000, cancellationToken);
                }
                finally
                {
                    _connected = false;
                }
            }
        }

        private static async Task ReadLoop(
            NamedPipeClientStream pipe,
            CancellationToken cancellationToken)
        {
            var lengthBuffer = new byte[4];
            while (pipe.IsConnected && !cancellationToken.IsCancellationRequested)
            {
                await ReadExact(pipe, lengthBuffer, cancellationToken);
                var length = BitConverter.ToInt32(lengthBuffer, 0);
                if (length <= 0 || length > RemoteProtocol.MaxMessageBytes)
                {
                    throw new InvalidDataException("Companion message exceeded the protocol limit.");
                }

                var payload = new byte[length];
                await ReadExact(pipe, payload, cancellationToken);
                var json = Encoding.UTF8.GetString(payload);
                var header = JsonUtility.FromJson<CommandEnvelope>(json);
                if (header != null && header.type == "command")
                {
                    if (header.protocolVersion != RemoteProtocol.Version)
                    {
                        Outbound.Enqueue(JsonUtility.ToJson(new ResultEnvelope
                        {
                            instanceId = InstanceId,
                            requestId = header.requestId,
                            success = false,
                            errorCode = "unsupported_protocol",
                            message = "The companion protocol version is unsupported."
                        }));
                    }
                    else if (string.IsNullOrEmpty(header.instanceId) ||
                             header.instanceId == InstanceId)
                    {
                        Commands.Enqueue(header);
                    }
                }
            }
        }

        private static async Task WriteMessage(
            Stream stream,
            string json,
            CancellationToken cancellationToken)
        {
            var payload = Encoding.UTF8.GetBytes(json);
            if (payload.Length > RemoteProtocol.MaxMessageBytes)
            {
                throw new InvalidDataException("Unity message exceeded the protocol limit.");
            }

            var length = BitConverter.GetBytes(payload.Length);
            await stream.WriteAsync(length, 0, length.Length, cancellationToken);
            await stream.WriteAsync(payload, 0, payload.Length, cancellationToken);
            await stream.FlushAsync(cancellationToken);
        }

        private static async Task ReadExact(
            Stream stream,
            byte[] buffer,
            CancellationToken cancellationToken)
        {
            var offset = 0;
            while (offset < buffer.Length)
            {
                var read = await stream.ReadAsync(
                    buffer,
                    offset,
                    buffer.Length - offset,
                    cancellationToken);
                if (read == 0)
                {
                    throw new EndOfStreamException();
                }

                offset += read;
            }
        }

        private static void Shutdown()
        {
            EditorApplication.update -= Update;
            AssemblyReloadEvents.beforeAssemblyReload -= Shutdown;
            EditorApplication.quitting -= Shutdown;
            Lifetime.Cancel();
        }
    }
}
