import { MaterialCommunityIcons } from "@expo/vector-icons";
import { Tabs } from "expo-router";
import { Image, Platform, StyleSheet } from "react-native";
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
            <Image
              source={require("../../assets/bezi-mascot-gray.png")}
              style={{ height: size - 2, width: size - 2 }}
              tintColor={color}
            />
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
    height: Platform.OS === "ios" ? 84 : 66,
    paddingTop: 7,
    backgroundColor: "rgba(31,30,29,0.98)",
    borderTopColor: colors.borderSoft,
    borderTopWidth: 1,
  },
  item: { paddingVertical: 2, maxWidth: 220 },
  label: { fontSize: 11, fontWeight: "600" },
});
