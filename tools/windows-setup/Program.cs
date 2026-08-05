namespace BeziRemoteSetup;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Any(value => value.Equals("--check", StringComparison.OrdinalIgnoreCase)))
        {
            try
            {
                InstallerEngine.ValidateEmbeddedPayload();
                Console.WriteLine("Bezi Buddy Setup payload check passed.");
                return 0;
            }
            catch (Exception exception)
            {
                Console.Error.WriteLine(exception.Message);
                return 1;
            }
        }

        ApplicationConfiguration.Initialize();
        Application.Run(new SetupForm());
        return 0;
    }
}
