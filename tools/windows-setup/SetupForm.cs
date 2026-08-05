using System.Diagnostics;
using System.Drawing.Drawing2D;

namespace BeziRemoteSetup;

internal sealed class SetupForm : Form
{
    private static readonly Color Background = Color.FromArgb(9, 13, 11);
    private static readonly Color Surface = Color.FromArgb(15, 23, 19);
    private static readonly Color SurfaceStrong = Color.FromArgb(21, 33, 27);
    private static readonly Color TextPrimary = Color.FromArgb(224, 238, 229);
    private static readonly Color TextSecondary = Color.FromArgb(146, 170, 155);
    private static readonly Color Accent = Color.FromArgb(102, 232, 165);
    private static readonly Color Success = Color.FromArgb(102, 232, 165);
    private static readonly Color Danger = Color.FromArgb(255, 119, 119);

    private readonly Panel _page = new() { Dock = DockStyle.Fill, BackColor = Background };
    private readonly Button _back = CreateButton("< BACK", secondary: true);
    private readonly Button _next = CreateButton("CONTINUE >");
    private readonly Label _stepLabel = NewLabel("[01:WELCOME]  02:UNITY  03:INSTALL", 9, Accent, FontStyle.Bold);
    private readonly TextBox _installPath = CreateTextBox(InstallerEngine.DefaultInstallDirectory);
    private readonly TextBox _unityPath = CreateTextBox(string.Empty);
    private readonly CheckBox _desktopShortcut = new()
    {
        Text = "Create a desktop shortcut",
        Checked = true,
        AutoSize = true,
        ForeColor = TextPrimary,
        Font = TerminalFont(10),
        BackColor = Color.Transparent
    };
    private readonly ProgressBar _progress = new()
    {
        Height = 8,
        Style = ProgressBarStyle.Continuous,
        Minimum = 0,
        Maximum = 100,
        Value = 0
    };
    private readonly Label _progressText = NewLabel("[WAITING] preparing setup", 10, TextSecondary);
    private readonly Label _unityValidation = NewLabel("[INPUT] choose your Unity project folder", 9, TextSecondary);
    private int _step;
    private string? _installedPath;

    public SetupForm()
    {
        Text = Distribution.ProductName;
        ClientSize = new Size(940, 720);
        MinimumSize = new Size(860, 660);
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Background;
        ForeColor = TextPrimary;
        Font = TerminalFont(10);
        Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);

        var header = new Panel { Dock = DockStyle.Top, Height = 76, Padding = new Padding(38, 20, 38, 12), BackColor = Background };
        var brand = NewLabel("●  BEZI_BUDDY.EXE", 12, TextPrimary, FontStyle.Bold);
        brand.Dock = DockStyle.Left;
        brand.AutoSize = true;
        _stepLabel.Dock = DockStyle.Right;
        _stepLabel.AutoSize = true;
        header.Controls.Add(_stepLabel);
        header.Controls.Add(brand);

        var footer = new Panel { Dock = DockStyle.Bottom, Height = 82, Padding = new Padding(38, 18, 38, 18), BackColor = Color.FromArgb(12, 18, 15) };
        _back.Width = 118;
        _back.Dock = DockStyle.Left;
        _back.Click += (_, _) => ShowStep(Math.Max(0, _step - 1));
        _next.Width = 190;
        _next.Dock = DockStyle.Right;
        _next.Click += async (_, _) => await AdvanceAsync();
        footer.Controls.Add(_next);
        footer.Controls.Add(_back);

        Controls.Add(_page);
        Controls.Add(footer);
        Controls.Add(header);
        ShowStep(0);
    }

    protected override void OnPaint(PaintEventArgs eventArgs)
    {
        base.OnPaint(eventArgs);
        using var brush = new LinearGradientBrush(
            new Rectangle(0, 0, Width, 210),
            Color.FromArgb(42, 51, 57),
            Background,
            LinearGradientMode.Vertical);
        eventArgs.Graphics.FillRectangle(brush, 0, 0, Width, 210);
    }

    private async Task AdvanceAsync()
    {
        if (_step == 0)
        {
            ShowStep(1);
            return;
        }
        if (_step == 1)
        {
            if (!InstallerEngine.IsUnityProject(_unityPath.Text, out var message))
            {
                _unityValidation.Text = message;
                _unityValidation.ForeColor = Danger;
                return;
            }
            ShowStep(2);
            return;
        }
        if (_step == 2)
        {
            await InstallAsync();
            return;
        }
        if (_installedPath is not null)
        {
            InstallerEngine.Launch(_installedPath);
            Close();
        }
    }

    private void ShowStep(int step)
    {
        _step = step;
        _page.Controls.Clear();
        _back.Enabled = step is > 0 and < 3;
        _back.Visible = step is > 0 and < 3;

        switch (step)
        {
            case 0:
                _stepLabel.Text = "[01:WELCOME]  02:UNITY  03:INSTALL";
                _next.Text = "START SETUP >";
                RenderWelcome();
                break;
            case 1:
                _stepLabel.Text = "01:WELCOME  [02:UNITY]  03:INSTALL";
                _next.Text = "CONTINUE >";
                RenderUnity();
                break;
            case 2:
                _stepLabel.Text = "01:WELCOME  02:UNITY  [03:INSTALL]";
                _next.Text = "RUN INSTALL >";
                RenderReady();
                break;
            default:
                _stepLabel.Text = "[EXIT 0]  READY";
                _next.Text = "LAUNCH >";
                _next.Width = 190;
                RenderComplete();
                break;
        }
    }

    private void RenderWelcome()
    {
        var content = ContentPanel();
        content.Controls.Add(Title("initialize remote workspace"));
        content.Controls.Add(Copy(
            $"[INFO] One bootstrap configures the Windows companion, secure relay, {Distribution.ClientName}, and Unity Editor bridge. After setup, one command starts everything."));

        var cards = new FlowLayoutPanel
        {
            AutoSize = true,
            FlowDirection = FlowDirection.LeftToRight,
            WrapContents = false,
            Margin = new Padding(0, 28, 0, 0),
            BackColor = Color.Transparent
        };
        cards.Controls.Add(FeatureCard("$ 01", Distribution.ClientName, Distribution.ClientDescription));
        cards.Controls.Add(FeatureCard("$ 02", "UNITY_BRIDGE", "Installs the Editor bridge. Scenes stay untouched."));
        cards.Controls.Add(FeatureCard("$ 03", "ONE_CLICK_LAUNCH", "Starts Bezi, Unity, relay, and companion."));
        content.Controls.Add(cards);
        _page.Controls.Add(content);
    }

    private void RenderUnity()
    {
        var content = ContentPanel();
        content.Controls.Add(Title("select unity project"));
        content.Controls.Add(Copy("[INPUT REQUIRED] Select the project root containing Assets and Packages. Only an Editor package will be installed."));
        content.Controls.Add(Field("UNITY_PROJECT_PATH=", _unityPath, () => BrowseUnityProject()));
        _unityValidation.Margin = new Padding(2, 8, 0, 18);
        content.Controls.Add(_unityValidation);
        content.Controls.Add(Field("INSTALL_PATH=", _installPath, () => BrowseInstallDirectory()));
        _desktopShortcut.Margin = new Padding(2, 18, 0, 0);
        content.Controls.Add(_desktopShortcut);
        _page.Controls.Add(content);
    }

    private void RenderReady()
    {
        var content = ContentPanel();
        content.Controls.Add(Title("review install plan"));
        content.Controls.Add(Copy("[READY] Missing prerequisites will be installed, then the runtime, Unity bridge, and one-click launcher will be configured."));
        content.Controls.Add(SummaryRow("INSTALL_PATH", _installPath.Text));
        content.Controls.Add(SummaryRow("UNITY_PROJECT", _unityPath.Text));
        content.Controls.Add(SummaryRow("MOBILE_TARGET", Distribution.TargetSummary));
        content.Controls.Add(SummaryRow("LAUNCH_TARGETS", "BEZI + UNITY + COMPANION + RELAY"));
        _page.Controls.Add(content);
    }

    private void RenderInstalling()
    {
        var content = ContentPanel();
        content.Controls.Add(Title("executing setup"));
        content.Controls.Add(Copy("[RUNNING] First install may take a few minutes. Windows can request permission for video and web runtimes."));
        _progress.Margin = new Padding(0, 38, 0, 18);
        _progress.Width = 750;
        content.Controls.Add(_progress);
        _progressText.Margin = new Padding(0, 0, 0, 0);
        content.Controls.Add(_progressText);
        _page.Controls.Add(content);
    }

    private void RenderComplete()
    {
        var content = ContentPanel();
        var badge = NewLabel("[EXIT 0] INSTALLATION COMPLETE", 10, Success, FontStyle.Bold);
        badge.AutoSize = true;
        badge.Margin = new Padding(0, 0, 0, 18);
        content.Controls.Add(badge);
        content.Controls.Add(Title("bezi buddy is ready"));
        content.Controls.Add(Copy(Distribution.IsAndroid
            ? "[NEXT] Install the Bezi Buddy APK on the Android phone. Launch this shortcut, then open the secure link emailed to the tester. Expo Go is not required."
            : "[NEXT] Install Expo Go on the iPhone or iPad, launch this shortcut, and open the exp:// link. Keep the terminal open while controlling Bezi or Unity."));
        if (!Distribution.IsAndroid)
        {
            var expoGo = CreateButton("OPEN EXPO GO APP STORE ↗", secondary: true);
            expoGo.Width = 290;
            expoGo.Height = 48;
            expoGo.Margin = new Padding(0, 28, 0, 0);
            expoGo.Click += (_, _) => InstallerEngine.OpenExpoGo();
            content.Controls.Add(expoGo);
        }
        _page.Controls.Add(content);
    }

    private async Task InstallAsync()
    {
        _back.Enabled = false;
        _next.Enabled = false;
        _page.Controls.Clear();
        RenderInstalling();
        try
        {
            var installPath = Path.GetFullPath(Environment.ExpandEnvironmentVariables(_installPath.Text.Trim()));
            var engine = new InstallerEngine((percent, message) =>
            {
                if (InvokeRequired)
                {
                    BeginInvoke(() => UpdateProgress(percent, message));
                }
                else
                {
                    UpdateProgress(percent, message);
                }
            });
            await engine.InstallAsync(new InstallRequest(
                installPath,
                _unityPath.Text.Trim(),
                _desktopShortcut.Checked));
            _installedPath = installPath;
            _next.Enabled = true;
            ShowStep(3);
        }
        catch (Exception exception)
        {
            _progressText.Text = $"[ERROR] {exception.Message}";
            _progressText.ForeColor = Danger;
            _back.Enabled = true;
            _next.Enabled = true;
            _next.Text = "RETRY >";
        }
    }

    private void UpdateProgress(int percent, string message)
    {
        _progress.Value = Math.Clamp(percent, 0, 100);
        _progressText.Text = $"[{percent:000}%] {message}";
        _progressText.ForeColor = percent == 100 ? Success : TextSecondary;
    }

    private void BrowseUnityProject()
    {
        using var dialog = new FolderBrowserDialog
        {
            Description = "Choose the Unity project folder containing Assets and Packages",
            UseDescriptionForTitle = true,
            ShowNewFolderButton = false,
            InitialDirectory = Directory.Exists(_unityPath.Text) ? _unityPath.Text : string.Empty
        };
        if (dialog.ShowDialog(this) != DialogResult.OK) return;
        _unityPath.Text = dialog.SelectedPath;
        var valid = InstallerEngine.IsUnityProject(dialog.SelectedPath, out var message);
        _unityValidation.Text = message;
        _unityValidation.ForeColor = valid ? Success : Danger;
    }

    private void BrowseInstallDirectory()
    {
        using var dialog = new FolderBrowserDialog
        {
            Description = "Choose where Bezi Buddy will be installed",
            UseDescriptionForTitle = true,
            ShowNewFolderButton = true,
            InitialDirectory = Directory.Exists(_installPath.Text)
                ? _installPath.Text
                : Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData)
        };
        if (dialog.ShowDialog(this) == DialogResult.OK) _installPath.Text = dialog.SelectedPath;
    }

    private static FlowLayoutPanel ContentPanel() => new()
    {
        Dock = DockStyle.Fill,
        FlowDirection = FlowDirection.TopDown,
        WrapContents = false,
        AutoScroll = true,
        Padding = new Padding(70, 54, 70, 32),
        BackColor = Color.Transparent
    };

    private static Label Title(string text)
    {
        var label = NewLabel($"> {text}_", 25, TextPrimary, FontStyle.Bold);
        label.MaximumSize = new Size(780, 0);
        label.AutoSize = true;
        label.Margin = new Padding(0, 0, 0, 16);
        return label;
    }

    private static Label Copy(string text)
    {
        var label = NewLabel(text, 11, TextSecondary);
        label.MaximumSize = new Size(740, 0);
        label.AutoSize = true;
        label.Margin = new Padding(0, 0, 0, 8);
        return label;
    }

    private static Panel FeatureCard(string number, string title, string copy)
    {
        var card = new Panel
        {
            Width = 242,
            Height = 190,
            Margin = new Padding(0, 0, 14, 0),
            Padding = new Padding(22),
            BackColor = Surface,
            BorderStyle = BorderStyle.FixedSingle
        };
        var numberLabel = NewLabel(number, 10, Accent, FontStyle.Bold);
        numberLabel.Location = new Point(22, 20);
        numberLabel.AutoSize = true;
        var titleLabel = NewLabel(title, 11, TextPrimary, FontStyle.Bold);
        titleLabel.Location = new Point(22, 57);
        titleLabel.AutoSize = true;
        var copyLabel = NewLabel(copy, 9, TextSecondary);
        copyLabel.Location = new Point(22, 94);
        copyLabel.Size = new Size(194, 78);
        copyLabel.AutoSize = false;
        card.Controls.Add(numberLabel);
        card.Controls.Add(titleLabel);
        card.Controls.Add(copyLabel);
        return card;
    }

    private static Panel Field(string label, TextBox textBox, Action browse)
    {
        var panel = new Panel { Width = 760, Height = 86, Margin = new Padding(0, 18, 0, 0), BackColor = Color.Transparent };
        var caption = NewLabel(label, 9, TextSecondary, FontStyle.Bold);
        caption.Location = new Point(0, 0);
        caption.AutoSize = true;
        textBox.Location = new Point(0, 28);
        textBox.Width = 650;
        var button = CreateButton("...", secondary: true);
        button.Location = new Point(662, 27);
        button.Size = new Size(98, 40);
        button.Click += (_, _) => browse();
        panel.Controls.Add(caption);
        panel.Controls.Add(textBox);
        panel.Controls.Add(button);
        return panel;
    }

    private static Panel SummaryRow(string label, string value)
    {
        var row = new Panel { Width = 760, Height = 62, BackColor = Surface, Margin = new Padding(0, 10, 0, 0), Padding = new Padding(18, 12, 18, 10) };
        var left = NewLabel(label, 9, TextSecondary, FontStyle.Bold);
        left.Dock = DockStyle.Left;
        left.Width = 155;
        var right = NewLabel(value, 10, TextPrimary);
        right.Dock = DockStyle.Fill;
        right.TextAlign = ContentAlignment.MiddleRight;
        right.AutoEllipsis = true;
        row.Controls.Add(right);
        row.Controls.Add(left);
        return row;
    }

    private static TextBox CreateTextBox(string value) => new()
    {
        Text = value,
        Height = 40,
        BorderStyle = BorderStyle.FixedSingle,
        BackColor = SurfaceStrong,
        ForeColor = TextPrimary,
        Font = TerminalFont(10),
        Margin = Padding.Empty
    };

    private static Button CreateButton(string text, bool secondary = false) => new()
    {
        Text = text,
        Height = 46,
        FlatStyle = FlatStyle.Flat,
        FlatAppearance = { BorderSize = 1, BorderColor = secondary ? Color.FromArgb(76, 73, 69) : Accent },
        BackColor = secondary ? SurfaceStrong : Accent,
        ForeColor = secondary ? TextPrimary : Color.FromArgb(15, 24, 29),
        Cursor = Cursors.Hand,
        Font = TerminalFont(10, FontStyle.Bold),
        UseVisualStyleBackColor = false
    };

    private static Label NewLabel(string text, float size, Color color, FontStyle style = FontStyle.Regular) => new()
    {
        Text = text,
        Font = TerminalFont(size, style),
        ForeColor = color,
        BackColor = Color.Transparent,
        AutoSize = true
    };

    private static Font TerminalFont(float size, FontStyle style = FontStyle.Regular)
    {
        using var fonts = new System.Drawing.Text.InstalledFontCollection();
        var family = fonts.Families.Any(value => value.Name.Equals("Cascadia Mono", StringComparison.OrdinalIgnoreCase))
            ? "Cascadia Mono"
            : "Consolas";
        return new Font(family, size, style);
    }
}
