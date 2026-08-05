import { QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SessionProvider } from "@/context/session-context";
import { queryClient } from "@/lib/query";
import { colors } from "@/theme/tokens";

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.background }}>
      <QueryClientProvider client={queryClient}>
        <SessionProvider>
          <StatusBar style="light" />
          <Stack
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: colors.background },
              animation: "fade_from_bottom",
            }}
          >
            <Stack.Screen name="(tabs)" />
            <Stack.Screen
              name="pair"
              options={{
                presentation: "fullScreenModal",
                animation: "slide_from_bottom",
              }}
            />
            <Stack.Screen
              name="bootstrap"
              options={{ presentation: "fullScreenModal", animation: "fade" }}
            />
          </Stack>
        </SessionProvider>
      </QueryClientProvider>
    </GestureHandlerRootView>
  );
}
