using System.Diagnostics;
using System.IO.Compression;
using System.Reflection;
using System.Runtime.InteropServices;
using Microsoft.Win32;

namespace BeziRemoteSetup;

internal sealed record PrerequisiteStatus(
    bool Node,
    bool Pnpm,
    bool Cloudflared,
    bool GStreamer,
    bool WebView2)
{
    public bool Ready => Node && Pnpm && Cloudflared && GStreamer && WebView2;
}

internal sealed record InstallRequest(
    string InstallDirectory,
    string UnityProject,
    bool CreateDesktopShortcut);

internal sealed class InstallerEngine
{
    private const string PayloadResource = "BeziBuddy.Payload.zip";
    private const string PnpmVersion = "10.33.0";
    private readonly Action<int, string> _progress;

    public InstallerEngine(Action<int, string> progress)
    {
        _progress = progress;
    }

    public static string DefaultInstallDirectory => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Programs",
        "Bezi Buddy");

    public static void ValidateEmbeddedPayload()
    {
        using var payload = OpenPayload();
        using var archive = new ZipArchive(payload, ZipArchiveMode.Read);
        string[] required =
        [
            "package.json",
            "pnpm-lock.yaml",
            "scripts/Start-ExpoGoProof.ps1",
            "scripts/Install-UnityPackage.ps1",
            "packages/unity/package.json",
            "apps/mobile/package.json",
            "apps/relay/package.json",
            "apps/companion/src-tauri/target/release/bezi-remote-companion.exe",
            "Bezi Buddy.exe"
        ];
        var entries = archive.Entries
            .Select(entry => entry.FullName.Replace('\\', '/'))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        var missing = required.Where(path => !entries.Contains(path)).ToArray();
        if (missing.Length > 0)
        {
            throw new InvalidDataException(
                $"The embedded setup payload is incomplete: {string.Join(", ", missing)}");
        }
    }

    public static bool IsUnityProject(string path, out string message)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            message = "Choose the folder that contains Assets and Packages.";
            return false;
        }

        try
        {
            var fullPath = Path.GetFullPath(Environment.ExpandEnvironmentVariables(path.Trim()));
            if (!Directory.Exists(Path.Combine(fullPath, "Assets")) ||
                !File.Exists(Path.Combine(fullPath, "Packages", "manifest.json")))
            {
                message = "That folder is not a Unity project.";
                return false;
            }

            message = "Unity project detected.";
            return true;
        }
        catch (Exception exception)
        {
            message = exception.Message;
            return false;
        }
    }

    public static async Task<PrerequisiteStatus> CheckPrerequisitesAsync()
    {
        var node = FindNode();
        var nodeReady = node is not null && await HasMinimumNodeVersionAsync(node, 22);
        var pnpm = FindPnpm();
        var pnpmReady = pnpm is not null && await HasMinimumCliVersionAsync(pnpm, 10);
        return new PrerequisiteStatus(
            nodeReady,
            pnpmReady,
            FindCloudflared() is not null,
            FindGStreamerRoot() is not null,
            IsWebView2Installed());
    }

    public async Task InstallAsync(InstallRequest request)
    {
        ValidateEmbeddedPayload();
        if (!IsUnityProject(request.UnityProject, out var projectMessage))
        {
            throw new InvalidOperationException(projectMessage);
        }

        var installDirectory = Path.GetFullPath(
            Environment.ExpandEnvironmentVariables(request.InstallDirectory));
        var unityProject = Path.GetFullPath(
            Environment.ExpandEnvironmentVariables(request.UnityProject));

        _progress(4, "Checking Windows prerequisites");
        await EnsurePrerequisitesAsync();

        _progress(35, "Installing Bezi Buddy application files");
        ExtractPayload(installDirectory);

        _progress(52, "Preparing the local relay and Android app runtime");
        await InstallWorkspaceDependenciesAsync(installDirectory);

        _progress(77, "Installing the Unity Editor bridge");
        await InstallUnityBridgeAsync(installDirectory, unityProject);

        _progress(91, "Creating one-click launcher shortcuts");
        CreateShortcuts(installDirectory, request.CreateDesktopShortcut);

        _progress(100, "Bezi Buddy is ready for Android, Bezi, and Unity");
    }

    public static void Launch(string installDirectory)
    {
        var launcher = Path.Combine(installDirectory, "Bezi Buddy.exe");
        if (!File.Exists(launcher))
        {
            throw new FileNotFoundException("The installed launcher is missing.", launcher);
        }
        Process.Start(new ProcessStartInfo
        {
            FileName = launcher,
            WorkingDirectory = installDirectory,
            UseShellExecute = true
        });
    }

    public static void OpenAndroidExpoGo()
    {
        Process.Start(new ProcessStartInfo
        {
            FileName = "https://play.google.com/store/apps/details?id=host.exp.exponent",
            UseShellExecute = true
        });
    }

    private async Task EnsurePrerequisitesAsync()
    {
        var status = await CheckPrerequisitesAsync();
        if (status.Ready) return;
        var winget = FindExecutable("winget.exe");
        if (winget is null)
        {
            throw new InvalidOperationException(
                "Windows App Installer (winget) is required to install missing prerequisites. " +
                "Install App Installer from Microsoft Store, then run setup again.");
        }

        if (!status.Node)
        {
            _progress(9, "Installing Node.js LTS");
            await InstallWingetPackageAsync(winget, "OpenJS.NodeJS.LTS");
        }
        if (!status.Cloudflared)
        {
            _progress(16, "Installing the secure Cloudflare tunnel helper");
            await InstallWingetPackageAsync(winget, "Cloudflare.cloudflared");
        }
        if (!status.GStreamer)
        {
            _progress(23, "Installing the GStreamer video runtime");
            await InstallWingetPackageAsync(winget, "gstreamerproject.gstreamer");
        }
        if (!status.WebView2)
        {
            _progress(29, "Installing Microsoft Edge WebView2 Runtime");
            await InstallWingetPackageAsync(winget, "Microsoft.EdgeWebView2Runtime");
        }

        var node = FindNode() ?? throw new InvalidOperationException(
            "Node.js installed but could not be found. Restart Windows and run setup again.");
        if (!await HasMinimumNodeVersionAsync(node, 22))
        {
            throw new InvalidOperationException("Bezi Buddy requires Node.js 22 or newer.");
        }
        if (FindCloudflared() is null || FindGStreamerRoot() is null)
        {
            throw new InvalidOperationException(
                "A prerequisite installer completed but its files were not found. Restart Windows and run setup again.");
        }

        if (!status.Pnpm)
        {
            _progress(32, $"Installing pnpm {PnpmVersion}");
            var npm = FindNpm(node) ?? throw new InvalidOperationException("npm was not installed with Node.js.");
            await RunAsync(npm, ["install", "--global", $"pnpm@{PnpmVersion}"]);
        }
    }

    private static async Task InstallWingetPackageAsync(string winget, string packageId)
    {
        await RunAsync(winget,
        [
            "install", "--id", packageId, "--exact", "--silent",
            "--accept-package-agreements", "--accept-source-agreements",
            "--disable-interactivity"
        ]);
    }

    private static void ExtractPayload(string installDirectory)
    {
        Directory.CreateDirectory(installDirectory);
        var installRoot = Path.GetFullPath(installDirectory)
            .TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        using var payload = OpenPayload();
        using var archive = new ZipArchive(payload, ZipArchiveMode.Read);
        foreach (var entry in archive.Entries)
        {
            var destination = Path.GetFullPath(Path.Combine(installDirectory, entry.FullName));
            if (!destination.StartsWith(installRoot, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidDataException("The setup payload contains an unsafe path.");
            }
            if (string.IsNullOrEmpty(entry.Name))
            {
                Directory.CreateDirectory(destination);
                continue;
            }
            Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
            entry.ExtractToFile(destination, overwrite: true);
        }
    }

    private static async Task InstallWorkspaceDependenciesAsync(string installDirectory)
    {
        var pnpm = FindPnpm() ?? throw new InvalidOperationException(
            "pnpm could not be found after installation.");
        await RunAsync(pnpm, ["install", "--frozen-lockfile"], installDirectory);
    }

    private static async Task InstallUnityBridgeAsync(string installDirectory, string unityProject)
    {
        var script = Path.Combine(installDirectory, "scripts", "Install-UnityPackage.ps1");
        var powershell = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.System),
            "WindowsPowerShell", "v1.0", "powershell.exe");
        await RunAsync(powershell,
        [
            "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script,
            "-UnityProject", unityProject,
            "-PackageSource", Path.Combine(installDirectory, "packages", "unity"),
            "-Confirm", "-Force"
        ], installDirectory);
    }

    private static void CreateShortcuts(string installDirectory, bool desktop)
    {
        var launcher = Path.Combine(installDirectory, "Bezi Buddy.exe");
        var startMenuDirectory = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.StartMenu),
            "Programs", "Bezi Buddy");
        Directory.CreateDirectory(startMenuDirectory);
        CreateShortcut(Path.Combine(startMenuDirectory, "Bezi Buddy.lnk"), launcher, installDirectory);

        if (desktop)
        {
            CreateShortcut(
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "Bezi Buddy.lnk"),
                launcher,
                installDirectory);
        }
    }

    private static void CreateShortcut(string shortcutPath, string target, string workingDirectory)
    {
        var shellType = Type.GetTypeFromProgID("WScript.Shell") ??
            throw new InvalidOperationException("Windows Script Host is unavailable.");
        var shell = Activator.CreateInstance(shellType) ??
            throw new InvalidOperationException("Windows Script Host could not start.");
        object? shortcut = null;
        try
        {
            shortcut = shellType.InvokeMember(
                "CreateShortcut",
                BindingFlags.InvokeMethod,
                binder: null,
                target: shell,
                args: [shortcutPath]);
            var shortcutType = shortcut!.GetType();
            shortcutType.InvokeMember("TargetPath", BindingFlags.SetProperty, null, shortcut, [target]);
            shortcutType.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, shortcut, [workingDirectory]);
            shortcutType.InvokeMember("Description", BindingFlags.SetProperty, null, shortcut, ["Launch Bezi Buddy for Android, Bezi, and Unity"]);
            shortcutType.InvokeMember("IconLocation", BindingFlags.SetProperty, null, shortcut, [$"{target},0"]);
            shortcutType.InvokeMember("Save", BindingFlags.InvokeMethod, null, shortcut, null);
        }
        finally
        {
            if (shortcut is not null && Marshal.IsComObject(shortcut)) Marshal.FinalReleaseComObject(shortcut);
            if (Marshal.IsComObject(shell)) Marshal.FinalReleaseComObject(shell);
        }
    }

    private static Stream OpenPayload()
    {
        return Assembly.GetExecutingAssembly().GetManifestResourceStream(PayloadResource) ??
            throw new InvalidOperationException(
                "This development build does not contain the Bezi Buddy payload. " +
                "Build it with scripts/Build-WindowsSetup.ps1.");
    }

    private static string? FindNode() => FindExecutable(
        "node.exe",
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe"),
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "nodejs", "node.exe"));

    private static string? FindNpm(string node) => FindExecutable(
        "npm.cmd",
        Path.Combine(Path.GetDirectoryName(node)!, "npm.cmd"));

    private static string? FindPnpm() => FindExecutable(
        "pnpm.cmd",
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "npm", "pnpm.cmd"),
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "pnpm", "pnpm.cmd"));

    private static string? FindCloudflared() => FindExecutable(
        "cloudflared.exe",
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "cloudflared", "cloudflared.exe"),
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Microsoft", "WinGet", "Links", "cloudflared.exe"));

    private static string? FindGStreamerRoot()
    {
        string[] roots =
        [
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "gstreamer", "1.0", "msvc_x86_64"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "gstreamer", "1.0", "msvc_x86_64"),
            @"C:\gstreamer\1.0\msvc_x86_64"
        ];
        return roots.FirstOrDefault(root => File.Exists(Path.Combine(root, "bin", "gstreamer-1.0-0.dll")));
    }

    private static string? FindExecutable(string name, params string[] candidates)
    {
        foreach (var candidate in candidates)
        {
            if (File.Exists(candidate)) return candidate;
        }
        foreach (var directory in (Environment.GetEnvironmentVariable("PATH") ?? string.Empty)
                     .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            try
            {
                var candidate = Path.Combine(directory.Trim('"'), name);
                if (File.Exists(candidate)) return candidate;
            }
            catch
            {
                // Ignore malformed PATH entries and continue through known locations.
            }
        }
        return null;
    }

    private static async Task<bool> HasMinimumNodeVersionAsync(string node, int minimumMajor)
    {
        try
        {
            var output = await RunAsync(node, ["--version"], captureOnly: true);
            return Version.TryParse(output.Trim().TrimStart('v'), out var version) &&
                version.Major >= minimumMajor;
        }
        catch
        {
            return false;
        }
    }

    private static async Task<bool> HasMinimumCliVersionAsync(string executable, int minimumMajor)
    {
        try
        {
            var output = await RunAsync(executable, ["--version"], captureOnly: true);
            return Version.TryParse(output.Trim().TrimStart('v'), out var version) &&
                version.Major >= minimumMajor;
        }
        catch
        {
            return false;
        }
    }

    private static bool IsWebView2Installed()
    {
        const string clientId = "{F3017226-FE2A-4295-8CFC-31EAB9B542A6}";
        string[] paths =
        [
            $@"SOFTWARE\Microsoft\EdgeUpdate\Clients\{clientId}",
            $@"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{clientId}"
        ];
        return paths.Any(path =>
        {
            using var machine = Registry.LocalMachine.OpenSubKey(path);
            using var user = Registry.CurrentUser.OpenSubKey(path);
            return machine?.GetValue("pv") is string || user?.GetValue("pv") is string;
        });
    }

    private static async Task<string> RunAsync(
        string fileName,
        IReadOnlyList<string> arguments,
        string? workingDirectory = null,
        bool captureOnly = false)
    {
        using var process = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = fileName,
                WorkingDirectory = workingDirectory ?? Environment.CurrentDirectory,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true
            }
        };
        foreach (var argument in arguments) process.StartInfo.ArgumentList.Add(argument);
        if (!process.Start()) throw new InvalidOperationException($"Could not start {Path.GetFileName(fileName)}.");
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync();
        var output = await stdout;
        var error = await stderr;
        if (process.ExitCode != 0)
        {
            var details = string.IsNullOrWhiteSpace(error) ? output : error;
            throw new InvalidOperationException(
                $"{Path.GetFileName(fileName)} failed ({process.ExitCode}). {details.Trim()}");
        }
        return captureOnly ? output : string.Concat(output, error);
    }
}
