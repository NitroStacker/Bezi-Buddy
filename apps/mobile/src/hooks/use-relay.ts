import { useQuery } from "@tanstack/react-query";
import { RelayClient } from "@/lib/relay-client";
import { loadSecureSettings } from "@/lib/secure-settings";

export function useSecureSettings() {
  return useQuery({
    queryKey: ["secure-settings"],
    queryFn: loadSecureSettings,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function useRelayHosts() {
  const settings = useSecureSettings();
  const hosts = useQuery({
    queryKey: ["hosts", settings.data?.relayUrl],
    enabled: Boolean(settings.data?.ownerToken),
    queryFn: () => new RelayClient(settings.data!).listHosts(),
    refetchInterval: 10_000,
  });
  return { settings, hosts };
}

