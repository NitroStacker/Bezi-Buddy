namespace BeziRemoteSetup;

internal static class Distribution
{
#if ANDROID_DISTRIBUTION
    public static bool IsAndroid => true;
    public const string ProductName = "Bezi Buddy Android Setup";
    public const string InstallFolder = "Bezi Buddy Android";
    public const string ShortcutName = "Bezi Buddy Android";
    public const string LauncherMode = "android";
    public const string ClientName = "ANDROID_APK";
    public const string ClientDescription = "Uses the standalone Bezi Buddy APK. Expo Go is not required.";
    public const string TargetSummary = "STANDALONE_APK + SECURE_APP_LINK";
#else
    public static bool IsAndroid => false;
    public const string ProductName = "Bezi Buddy iOS Expo Go Setup";
    public const string InstallFolder = "Bezi Buddy iOS";
    public const string ShortcutName = "Bezi Buddy iOS";
    public const string LauncherMode = "expo-go";
    public const string ClientName = "IOS_EXPO_GO";
    public const string ClientDescription = "Expo Go opens the secure session link on iPhone or iPad.";
    public const string TargetSummary = "IOS + EXPO_GO + SECURE_CLOUDFLARE_LINK";
#endif
}
