import { MaterialCommunityIcons } from "@expo/vector-icons";
import { Tabs } from "expo-router";
import { Platform, StyleSheet } from "react-native";
import { colors } from "@/theme/tokens";

export default function TabsLayout() {
  return (
    <Tabs
      initialRouteName="bezi"
      screenOptions={{
        headerShown: false,
        sceneStyle: { backgroundColor: colors.background },
        tabBarActiveTintColor: colors.primaryStrong,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarLabelStyle: styles.label,
        tabBarStyle: styles.bar,
        tabBarItemStyle: styles.item,
        tabBarHideOnKeyboard: true,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Home",
          href: null,
          tabBarIcon: ({ color, size }) => (
            <MaterialCommunityIcons color={color} size={size} name="view-dashboard-outline" />
          ),
        }}
      />
      <Tabs.Screen
        name="bezi"
        options={{
          title: "Bezi",
          tabBarIcon: ({ color, size }) => (
            <MaterialCommunityIcons color={color} size={size} name="message-text-outline" />
          ),
        }}
      />
      <Tabs.Screen
        name="unity"
        options={{
          title: "Unity",
          tabBarIcon: ({ color, size }) => (
            <MaterialCommunityIcons color={color} size={size} name="unity" />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: "Settings",
          href: null,
          tabBarIcon: ({ color, size }) => (
            <MaterialCommunityIcons color={color} size={size} name="tune-variant" />
          ),
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: "absolute",
    height: Platform.OS === "ios" ? 88 : 70,
    paddingTop: 8,
    backgroundColor: "rgba(35,34,33,0.97)",
    borderTopColor: colors.borderSoft,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  item: { paddingVertical: 3, maxWidth: 220 },
  label: { fontSize: 11.5, fontWeight: "600" },
});
