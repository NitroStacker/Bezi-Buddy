using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace BeziRemoteLauncher;

internal static class Program
{
    private const string ProofScript = "scripts\\Start-ExpoGoProof.ps1";
    private const string ClearLine = "\r\u001b[2K";
    private const int WelcomeCanvasHeight = 17;
    private const int WelcomeCanvasWidth = 48;
    private const int GreetingColumn = 33;
    private static readonly object ConsoleLock = new();
    private static readonly object StateLock = new();
    private static readonly Queue<string> Diagnostics = new();
    private static string _loadingMessage = "Waking up Bezi Buddy";
    private static string? _expoUrl;
    private static bool _urlCopied;
    private static string _emailStatus = "not-configured";
    private static string _emailMessage = "Email delivery is not configured.";
    private static bool _cancelRequested;
    private static Process? _proofProcess;
    private static int _welcomeCanvasTop;
    private static string[] _welcomeCanvas =
        Enumerable.Repeat(new string(' ', WelcomeCanvasWidth), WelcomeCanvasHeight).ToArray();

    private static readonly string[] MascotOpen = CreateMascot(
        "   ████████   █████   ████████",
        "   ████████   █████   ████████",
        "   ████████   █████   ████████");

    private static readonly string[] MascotBlink = CreateMascot(
        "   ███████████████████████████",
        "   ████████   █████   ████████",
        "   ███████████████████████████");

    private static readonly string[] MascotLookLeft = CreateMascot(
        "   ███████   █████   █████████",
        "   ███████   █████   █████████",
        "   ███████   █████   █████████");

    private static readonly string[] MascotLookRight = CreateMascot(
        "   █████████   █████   ███████",
        "   █████████   █████   ███████",
        "   █████████   █████   ███████");

    private static readonly string[] MascotSquash =
    [
        "        █████████████████",
        "     ███████████████████████",
        "   ███████████████████████████",
        "  █████████████████████████████",
        "  █████████   █████   █████████",
        "  █████████   █████   █████████",
        "  █████████████████████████████",
        "  █████████████████████████████",
        "  █████████████████████████████",
        "  █████████████████████████████"
    ];

    private static readonly string[] MascotStretch =
    [
        "            █████████",
        "          █████████████",
        "        █████████████████",
        "       ███████████████████",
        "      █████████████████████",
        "     ███████████████████████",
        "     ██████  ███████  ██████",
        "     ██████  ███████  ██████",
        "     ██████  ███████  ██████",
        "     ███████████████████████",
        "     ███████████████████████",
        "     ███████████████████████",
        "     ███████████████████████",
        "     ███████████████████████",
        "     ███████████████████████"
    ];

    private static async Task<int> Main(string[] args)
    {
        Console.Title = "Bezi Buddy";
        Console.OutputEncoding = System.Text.Encoding.UTF8;

        var workspace = FindWorkspace(args);
        if (workspace is null)
        {
            return Fail(
                "I couldn't find the Bezi Remote installation.\n\n" +
                "Keep this EXE inside the Bezi Remote folder (or its dist folder), " +
                "or launch it with --workspace \"R:\\path\\to\\Bezi Remote\".");
        }

        if (args.Any(argument => argument.Equals("--check", StringComparison.OrdinalIgnoreCase)))
        {
            var companion = Path.Combine(
                workspace,
                "apps",
                "companion",
                "src-tauri",
                "target",
                "release",
                "bezi-remote-companion.exe");
            if (!File.Exists(companion))
            {
                return Fail($"The built native companion is missing:\n{companion}");
            }

            Console.WriteLine("Bezi Buddy launcher check passed.");
            return 0;
        }

        var forceEmailSetup = args.Any(argument =>
            argument.Equals("--configure-email", StringComparison.OrdinalIgnoreCase));
        if (forceEmailSetup || !IsEmailConfigured())
        {
            var setupExitCode = await RunEmailSetupAsync(workspace);
            if (forceEmailSetup)
            {
                return setupExitCode;
            }
            if (setupExitCode is not 0 and not 2)
            {
                return Fail("Gmail delivery setup did not complete.");
            }
        }

        await PlayWelcomeAnimationAsync();

        var script = Path.Combine(workspace, ProofScript);
        using var proofJob = WindowsJobObject.CreateKillOnClose();
        using var powershell = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.System),
                    "WindowsPowerShell",
                    "v1.0",
                    "powershell.exe"),
                WorkingDirectory = workspace,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true
            },
            EnableRaisingEvents = true
        };
        powershell.StartInfo.ArgumentList.Add("-NoProfile");
        powershell.StartInfo.ArgumentList.Add("-ExecutionPolicy");
        powershell.StartInfo.ArgumentList.Add("Bypass");
        powershell.StartInfo.ArgumentList.Add("-File");
        powershell.StartInfo.ArgumentList.Add(script);
        powershell.StartInfo.ArgumentList.Add("-UseBuiltCompanion");
        powershell.StartInfo.ArgumentList.Add("-CopyExpoUrl");
        powershell.StartInfo.ArgumentList.Add("-LauncherMode");
        if (args.Any(argument =>
            argument.Equals("--skip-email", StringComparison.OrdinalIgnoreCase)))
        {
            powershell.StartInfo.ArgumentList.Add("-SkipEmail");
        }

        using var loadingCancellation = new CancellationTokenSource();
        var ready = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        Console.CancelKeyPress += OnCancelKeyPress;

        try
        {
            if (!powershell.Start())
            {
                return Fail("Windows PowerShell could not be started.");
            }
            _proofProcess = powershell;
            try
            {
                proofJob.Assign(powershell);
            }
            catch
            {
                powershell.Kill(entireProcessTree: true);
                throw;
            }

            var standardOutput = PumpOutputAsync(powershell.StandardOutput, ready, isError: false);
            var standardError = PumpOutputAsync(powershell.StandardError, ready, isError: true);
            var loadingAnimation = RunLoadingAnimationAsync(loadingCancellation.Token);
            var mascotAnimation = RunMascotIdleAnimationAsync(loadingCancellation.Token);
            var processExit = powershell.WaitForExitAsync();

            var startupResult = await Task.WhenAny(ready.Task, processExit);
            loadingCancellation.Cancel();
            await Task.WhenAll(
                IgnoreCancellationAsync(loadingAnimation),
                IgnoreCancellationAsync(mascotAnimation));
            ClearActiveLine();

            if (startupResult == processExit)
            {
                await Task.WhenAll(standardOutput, standardError);
                if (_cancelRequested)
                {
                    WriteStopped();
                    return 0;
                }

                return Fail(BuildStartupError(powershell.ExitCode));
            }

            WriteReady();
            await processExit;
            await Task.WhenAll(standardOutput, standardError);

            if (_cancelRequested)
            {
                WriteStopped();
                return 0;
            }

            if (powershell.ExitCode != 0)
            {
                return Fail(BuildStartupError(powershell.ExitCode));
            }

            return 0;
        }
        catch (Exception exception)
        {
            loadingCancellation.Cancel();
            ClearActiveLine();
            return Fail($"Bezi Buddy couldn't start:\n{exception.Message}");
        }
        finally
        {
            _proofProcess = null;
            Console.CursorVisible = true;
            Console.CancelKeyPress -= OnCancelKeyPress;
        }
    }

    private static async Task PlayWelcomeAnimationAsync()
    {
        Console.CursorVisible = false;
        Console.Clear();
        _welcomeCanvasTop = Console.CursorTop;
        _welcomeCanvas =
            Enumerable.Repeat(new string(' ', WelcomeCanvasWidth), WelcomeCanvasHeight).ToArray();

        RenderWelcomeFrame(MascotOpen);
        await Task.Delay(220);

        for (var jump = 0; jump < 3; jump++)
        {
            RenderWelcomeFrame(MascotSquash);
            await Task.Delay(110);
            RenderWelcomeFrame(MascotStretch, jumpHeight: 1);
            await Task.Delay(90);
            RenderWelcomeFrame(MascotOpen, jumpHeight: 3);
            await Task.Delay(125);
            RenderWelcomeFrame(MascotStretch, jumpHeight: 1);
            await Task.Delay(90);
            RenderWelcomeFrame(MascotSquash);
            await Task.Delay(105);
            RenderWelcomeFrame(MascotOpen);
            await Task.Delay(jump == 2 ? 180 : 110);
        }

        RenderWelcomeFrame(MascotOpen, greeting: "Hello!");
        Console.WriteLine();
        Console.ForegroundColor = ConsoleColor.White;
        Console.WriteLine("       Welcome to Bezi Buddy!");
        Console.ResetColor();
        Console.WriteLine();
    }

    private static string[] CreateMascot(string eyeTop, string eyeMiddle, string eyeBottom) =>
    [
        "           ███████████",
        "        █████████████████",
        "      █████████████████████",
        "     ███████████████████████",
        "    █████████████████████████",
        "    ██████████████████████████",
        eyeTop,
        eyeMiddle,
        eyeBottom,
        "   ███████████████████████████",
        "   ███████████████████████████",
        "   ███████████████████████████",
        "   ███████████████████████████"
    ];

    private static void RenderWelcomeFrame(
        string[] mascot,
        int jumpHeight = 0,
        string? greeting = null)
    {
        var nextCanvas =
            Enumerable.Repeat(new string(' ', WelcomeCanvasWidth), WelcomeCanvasHeight).ToArray();
        var mascotTop = Math.Max(0, WelcomeCanvasHeight - mascot.Length - jumpHeight);
        for (var row = 0; row < mascot.Length && mascotTop + row < WelcomeCanvasHeight; row++)
        {
            var line = mascot[row];
            if (line.Length > WelcomeCanvasWidth)
            {
                line = line[..WelcomeCanvasWidth];
            }
            nextCanvas[mascotTop + row] =
                line.PadRight(WelcomeCanvasWidth);
        }

        if (!string.IsNullOrEmpty(greeting))
        {
            var greetingRow = WelcomeCanvasHeight - MascotOpen.Length + 4;
            var line = nextCanvas[greetingRow].ToCharArray();
            greeting.AsSpan(0, Math.Min(greeting.Length, line.Length - GreetingColumn))
                .CopyTo(line.AsSpan(GreetingColumn));
            nextCanvas[greetingRow] = new string(line);
        }

        lock (ConsoleLock)
        {
            var returnLeft = Console.CursorLeft;
            var returnTop = Console.CursorTop;
            Console.ForegroundColor = ConsoleColor.White;

            for (var row = 0; row < WelcomeCanvasHeight; row++)
            {
                WriteChangedRuns(
                    _welcomeCanvas[row],
                    nextCanvas[row],
                    _welcomeCanvasTop + row);
            }

            Console.ResetColor();
            _welcomeCanvas = nextCanvas;
            Console.SetCursorPosition(
                returnLeft,
                Math.Max(returnTop, _welcomeCanvasTop + WelcomeCanvasHeight));
        }
    }

    private static void WriteChangedRuns(string previous, string next, int row)
    {
        var column = 0;
        while (column < WelcomeCanvasWidth)
        {
            while (column < WelcomeCanvasWidth && previous[column] == next[column])
            {
                column++;
            }
            if (column >= WelcomeCanvasWidth)
            {
                return;
            }

            var runStart = column;
            while (column < WelcomeCanvasWidth && previous[column] != next[column])
            {
                column++;
            }

            Console.SetCursorPosition(runStart, row);
            Console.Write(next.Substring(runStart, column - runStart));
        }
    }

    private static async Task RunMascotIdleAnimationAsync(CancellationToken cancellationToken)
    {
        var showBlink = true;
        try
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                await Task.Delay(
                    showBlink
                        ? Random.Shared.Next(1400, 2400)
                        : Random.Shared.Next(2200, 3600),
                    cancellationToken);

                if (showBlink)
                {
                    RenderWelcomeFrame(MascotBlink, greeting: "Hello!");
                    await Task.Delay(105, cancellationToken);
                    RenderWelcomeFrame(MascotOpen, greeting: "Hello!");
                }
                else
                {
                    var firstGlance = Random.Shared.Next(2) == 0
                        ? MascotLookLeft
                        : MascotLookRight;
                    var secondGlance = ReferenceEquals(firstGlance, MascotLookLeft)
                        ? MascotLookRight
                        : MascotLookLeft;
                    RenderWelcomeFrame(firstGlance, greeting: "Hello!");
                    await Task.Delay(420, cancellationToken);
                    RenderWelcomeFrame(MascotOpen, greeting: "Hello!");
                    await Task.Delay(180, cancellationToken);
                    RenderWelcomeFrame(secondGlance, greeting: "Hello!");
                    await Task.Delay(360, cancellationToken);
                    RenderWelcomeFrame(MascotOpen, greeting: "Hello!");
                }

                showBlink = !showBlink;
            }
        }
        catch (OperationCanceledException)
        {
            // Startup is ready; leave the mascot in its neutral pose.
        }
        finally
        {
            RenderWelcomeFrame(MascotOpen, greeting: "Hello!");
        }
    }

    private static async Task RunLoadingAnimationAsync(CancellationToken cancellationToken)
    {
        var frames = new[] { "|", "/", "-", "\\" };
        var frame = 0;
        var displayedMessage = string.Empty;

        try
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                string message;
                lock (StateLock)
                {
                    message = _loadingMessage;
                }

                lock (ConsoleLock)
                {
                    if (!message.Equals(displayedMessage, StringComparison.Ordinal))
                    {
                        Console.Write(ClearLine);
                        Console.ForegroundColor = ConsoleColor.Cyan;
                        Console.Write($"       {frames[frame]}  ");
                        Console.ResetColor();
                        Console.Write(message);
                        displayedMessage = message;
                    }
                    else
                    {
                        // Redraw only the spinner character. Rewriting and clearing
                        // the complete status line every frame makes Windows Terminal
                        // flash even though the message itself has not changed.
                        Console.Write($"\r       {frames[frame]}");
                    }
                }

                frame = (frame + 1) % frames.Length;
                await Task.Delay(120, cancellationToken);
            }
        }
        catch (OperationCanceledException)
        {
            // The ready or stopped state replaces the loading line.
        }
    }

    private static async Task PumpOutputAsync(
        StreamReader reader,
        TaskCompletionSource ready,
        bool isError)
    {
        while (await reader.ReadLineAsync() is { } line)
        {
            if (line.StartsWith("BEZI_PROGRESS|", StringComparison.Ordinal))
            {
                var parts = line.Split('|', 3);
                if (parts.Length == 3)
                {
                    lock (StateLock)
                    {
                        _loadingMessage = parts[2];
                    }
                }
                continue;
            }

            if (line.StartsWith("BEZI_READY|", StringComparison.Ordinal))
            {
                var parts = line.Split('|', 3);
                if (parts.Length >= 2)
                {
                    lock (StateLock)
                    {
                        _expoUrl = parts[1];
                        _urlCopied = parts.Length == 3 &&
                            bool.TryParse(parts[2], out var copied) &&
                            copied;
                    }
                    ready.TrySetResult();
                }
                continue;
            }

            if (line.StartsWith("BEZI_EMAIL|", StringComparison.Ordinal))
            {
                var parts = line.Split('|', 3);
                if (parts.Length == 3)
                {
                    lock (StateLock)
                    {
                        _emailStatus = parts[1];
                        _emailMessage = parts[2];
                    }
                }
                continue;
            }

            if (!string.IsNullOrWhiteSpace(line))
            {
                AddDiagnostic(isError ? $"Error: {line}" : line);
            }
        }
    }

    private static void WriteReady()
    {
        Console.ForegroundColor = ConsoleColor.Green;
        Console.WriteLine("       [READY] Bezi Buddy is connected!");
        Console.ResetColor();
        Console.WriteLine();
        Console.ForegroundColor = ConsoleColor.Cyan;
        Console.WriteLine("       Open this URL in Expo Go:");
        Console.ForegroundColor = ConsoleColor.White;
        Console.WriteLine($"       {_expoUrl}");
        Console.ResetColor();
        if (_urlCopied)
        {
            Console.ForegroundColor = ConsoleColor.Green;
            Console.WriteLine("       Copied to your clipboard.");
            Console.ResetColor();
        }
        if (_emailStatus.Equals("sent", StringComparison.Ordinal))
        {
            Console.ForegroundColor = ConsoleColor.Green;
            Console.WriteLine($"       {_emailMessage}");
            Console.ResetColor();
        }
        else if (_emailStatus.Equals("failed", StringComparison.Ordinal))
        {
            Console.ForegroundColor = ConsoleColor.Yellow;
            Console.WriteLine($"       {_emailMessage}");
            Console.ResetColor();
        }
        Console.WriteLine();
        Console.ForegroundColor = ConsoleColor.DarkGray;
        Console.WriteLine("       Keep this window open. Press Ctrl+C to stop.");
        Console.ResetColor();
    }

    private static void WriteStopped()
    {
        ClearActiveLine();
        Console.ForegroundColor = ConsoleColor.DarkGray;
        Console.WriteLine();
        Console.WriteLine("       Bezi Buddy has stopped. See you next time!");
        Console.ResetColor();
    }

    private static void OnCancelKeyPress(object? sender, ConsoleCancelEventArgs eventArgs)
    {
        _cancelRequested = true;
        eventArgs.Cancel = true;
        ClearActiveLine();
        Console.ForegroundColor = ConsoleColor.Yellow;
        Console.WriteLine("       Stopping Bezi Buddy...");
        Console.ResetColor();
        try
        {
            _proofProcess?.Kill(entireProcessTree: true);
        }
        catch
        {
            // The proof process may already be finishing.
        }
    }

    private static void ClearActiveLine()
    {
        Console.Write(ClearLine);
    }

    private static async Task IgnoreCancellationAsync(Task task)
    {
        try
        {
            await task;
        }
        catch (OperationCanceledException)
        {
            // Expected when startup finishes.
        }
    }

    private static string BuildStartupError(int exitCode)
    {
        string[] details;
        lock (StateLock)
        {
            details = Diagnostics.TakeLast(5).ToArray();
        }

        var diagnosticText = details.Length == 0
            ? "Check the .proof folder for service logs."
            : string.Join(Environment.NewLine, details);
        return $"Bezi Buddy stopped during startup (exit code {exitCode}).\n{diagnosticText}";
    }

    private static void AddDiagnostic(string line)
    {
        lock (StateLock)
        {
            Diagnostics.Enqueue(line);
            while (Diagnostics.Count > 40)
            {
                Diagnostics.Dequeue();
            }
        }
    }

    private static bool IsEmailConfigured()
    {
        var configPath = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Bezi Remote",
            "gmail-delivery.json");
        return File.Exists(configPath);
    }

    private static async Task<int> RunEmailSetupAsync(string workspace)
    {
        var setupScript = Path.Combine(workspace, "scripts", "Configure-GmailDelivery.ps1");
        if (!File.Exists(setupScript))
        {
            return Fail("The Gmail delivery setup script is missing.");
        }

        using var setup = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.System),
                    "WindowsPowerShell",
                    "v1.0",
                    "powershell.exe"),
                WorkingDirectory = workspace,
                UseShellExecute = false
            }
        };
        setup.StartInfo.ArgumentList.Add("-NoProfile");
        setup.StartInfo.ArgumentList.Add("-ExecutionPolicy");
        setup.StartInfo.ArgumentList.Add("Bypass");
        setup.StartInfo.ArgumentList.Add("-File");
        setup.StartInfo.ArgumentList.Add(setupScript);

        if (!setup.Start())
        {
            return 1;
        }

        await setup.WaitForExitAsync();
        return setup.ExitCode;
    }

    private static string? FindWorkspace(string[] args)
    {
        var workspaceArgument = ReadWorkspaceArgument(args);
        if (workspaceArgument is not null)
        {
            var explicitWorkspace = Path.GetFullPath(
                Environment.ExpandEnvironmentVariables(workspaceArgument));
            return IsWorkspace(explicitWorkspace) ? explicitWorkspace : null;
        }

        var environmentWorkspace = Environment.GetEnvironmentVariable("BEZI_REMOTE_WORKSPACE");
        if (!string.IsNullOrWhiteSpace(environmentWorkspace))
        {
            var configuredWorkspace = Path.GetFullPath(
                Environment.ExpandEnvironmentVariables(environmentWorkspace));
            if (IsWorkspace(configuredWorkspace))
            {
                return configuredWorkspace;
            }
        }

        foreach (var startingDirectory in new[] { AppContext.BaseDirectory, Environment.CurrentDirectory })
        {
            var candidate = new DirectoryInfo(startingDirectory);
            while (candidate is not null)
            {
                if (IsWorkspace(candidate.FullName))
                {
                    return candidate.FullName;
                }

                candidate = candidate.Parent;
            }
        }

        return null;
    }

    private static string? ReadWorkspaceArgument(string[] args)
    {
        for (var index = 0; index < args.Length; index++)
        {
            if (args[index].Equals("--workspace", StringComparison.OrdinalIgnoreCase) &&
                index + 1 < args.Length)
            {
                return args[index + 1];
            }

            const string prefix = "--workspace=";
            if (args[index].StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            {
                return args[index][prefix.Length..];
            }
        }

        return null;
    }

    private static bool IsWorkspace(string path) =>
        File.Exists(Path.Combine(path, ProofScript)) &&
        File.Exists(Path.Combine(path, "package.json"));

    private static int Fail(string message)
    {
        ClearActiveLine();
        Console.CursorVisible = true;
        Console.ForegroundColor = ConsoleColor.Red;
        Console.WriteLine();
        Console.WriteLine(message);
        Console.ResetColor();

        if (!Console.IsInputRedirected)
        {
            Console.WriteLine();
            Console.Write("Press Enter to close...");
            Console.ReadLine();
        }

        return 1;
    }
}

internal sealed class WindowsJobObject : IDisposable
{
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;
    private const int JobObjectExtendedLimitInformationClass = 9;
    private readonly SafeJobHandle _handle;

    private WindowsJobObject(SafeJobHandle handle)
    {
        _handle = handle;
    }

    public static WindowsJobObject CreateKillOnClose()
    {
        var handle = NativeMethods.CreateJobObject(IntPtr.Zero, null);
        if (handle.IsInvalid)
        {
            throw new InvalidOperationException(
                $"Windows could not create the Bezi Buddy process group ({Marshal.GetLastWin32Error()}).");
        }

        var information = new JobObjectExtendedLimitInformation
        {
            BasicLimitInformation = new JobObjectBasicLimitInformation
            {
                LimitFlags = JobObjectLimitKillOnJobClose
            }
        };
        if (!NativeMethods.SetInformationJobObject(
            handle,
            JobObjectExtendedLimitInformationClass,
            ref information,
            (uint)Marshal.SizeOf<JobObjectExtendedLimitInformation>()))
        {
            var error = Marshal.GetLastWin32Error();
            handle.Dispose();
            throw new InvalidOperationException(
                $"Windows could not configure the Bezi Buddy process group ({error}).");
        }

        return new WindowsJobObject(handle);
    }

    public void Assign(Process process)
    {
        if (!NativeMethods.AssignProcessToJobObject(_handle, process.Handle))
        {
            throw new InvalidOperationException(
                $"Windows could not attach the Bezi Buddy services to their process group " +
                $"({Marshal.GetLastWin32Error()}).");
        }
    }

    public void Dispose()
    {
        _handle.Dispose();
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectBasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectExtendedLimitInformation
    {
        public JobObjectBasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    private sealed class SafeJobHandle : SafeHandleZeroOrMinusOneIsInvalid
    {
        private SafeJobHandle()
            : base(ownsHandle: true)
        {
        }

        protected override bool ReleaseHandle()
        {
            return NativeMethods.CloseHandle(handle);
        }
    }

    private static class NativeMethods
    {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern SafeJobHandle CreateJobObject(
            IntPtr jobAttributes,
            string? name);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool SetInformationJobObject(
            SafeJobHandle job,
            int informationClass,
            ref JobObjectExtendedLimitInformation information,
            uint informationLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool AssignProcessToJobObject(
            SafeJobHandle job,
            IntPtr process);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool CloseHandle(IntPtr handle);
    }
}
