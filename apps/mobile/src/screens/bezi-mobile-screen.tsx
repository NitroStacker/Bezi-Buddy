import { MaterialCommunityIcons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import {
  type Dispatch,
  type MutableRefObject,
  type PropsWithChildren,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  AppState,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { BeziMarkdown } from "@/components/bezi-markdown";
import { ActionButton, Card } from "@/components/primitives";
import { RemoteSurface } from "@/components/remote-surface";
import { useSession } from "@/context/session-context";
import { useRemoteStream } from "@/hooks/use-remote-stream";
import {
  initialBeziLaunchState,
  isBeziLaunchPending,
  reduceBeziLaunchState,
  type BeziLaunchState,
} from "@/lib/bezi-launch-flow";
import {
  areBeziHistoriesEqual,
  buildBeziLineDiff,
  decideBeziHistorySync,
  parseBeziSessions,
  parseLoadedBeziHistory,
  reduceBeziSessionUpdate,
  resolveBeziHistoryReconciliation,
  statusFromBeziUpdate,
  type BeziAgentStatus,
  type BeziChatEntry,
  type BeziDiffFile,
  type BeziSession,
} from "@/lib/bezi-session";
import {
  applyWorkspaceFolderState,
  parseWorkspaceItems,
  type WorkspaceItem,
} from "@/lib/bezi-workspace";
import { colors, radius, spacing, typography } from "@/theme/tokens";

type BeziDestination =
  | "threads"
  | "pages"
  | "plans"
  | "rules"
  | "skills"
  | "remote";

type WorkspaceProject = {
  id: string;
  label: string;
  path: string;
  lastModified?: string | null;
};

type BeziWorkspace = {
  id: string;
  label: string;
  projects: WorkspaceProject[];
  activeProjectId: string | null;
  isActive: boolean;
  pages: WorkspaceItem[];
  canvases: WorkspaceItem[];
  navigation: WorkspaceItem[];
};

type ChatEntry = BeziChatEntry;

type PermissionOption = { optionId: string; name: string; kind?: string };

type RemotePermission = {
  requestId: unknown;
  title: string;
  options: PermissionOption[];
};

type AdvertisedChoice = { id: string; name: string };

const DRAWER_DESTINATIONS: {
  id: BeziDestination;
  label: string;
  icon: keyof typeof MaterialCommunityIcons.glyphMap;
}[] = [
  { id: "threads", label: "Threads", icon: "message-text-outline" },
  { id: "pages", label: "Pages", icon: "file-document-outline" },
  { id: "plans", label: "Plans", icon: "format-list-checks" },
  { id: "rules", label: "Your Rules", icon: "book-cog-outline" },
  { id: "skills", label: "Skills", icon: "puzzle-outline" },
  { id: "remote", label: "Full Remote", icon: "monitor-share" },
];

export default function BeziMobileScreen() {
  const {
    connected,
    capabilities,
    hasControl,
    releaseControl,
    send,
    subscribe,
    takeControl,
  } = useSession();
  const [launchState, dispatchLaunch] = useReducer(
    reduceBeziLaunchState,
    initialBeziLaunchState,
  );
  const [destination, setDestination] = useState<BeziDestination>("threads");
  const [composer, setComposer] = useState("");
  const [sessions, setSessions] = useState<BeziSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatEntry[]>([]);
  const [agentStatus, setAgentStatus] = useState<BeziAgentStatus | null>(null);
  const [permission, setPermission] = useState<RemotePermission | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [choicePicker, setChoicePicker] = useState<"mode" | "model" | null>(null);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(
    null,
  );
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedDiff, setSelectedDiff] = useState<BeziDiffFile | null>(null);
  const [remoteTitle, setRemoteTitle] = useState("Full Remote");
  const [sessionBusy, setSessionBusy] = useState(false);
  const [folderBusyId, setFolderBusyId] = useState<string | null>(null);
  const [folderExpansionOverrides, setFolderExpansionOverrides] = useState<
    Record<string, boolean>
  >({});
  const [error, setError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<Record<string, unknown> | null>(null);
  const [choices, setChoices] = useState<{
    modes: AdvertisedChoice[];
    models: AdvertisedChoice[];
    mode?: string;
    model?: string;
  }>({ modes: [], models: [] });
  const newRequest = useRef<string | null>(null);
  const promptRequest = useRef<string | null>(null);
  const loadRequest = useRef<string | null>(null);
  const listRequest = useRef<string | null>(null);
  const catalogRequest = useRef<string | null>(null);
  const folderRequest = useRef<string | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  const activeSessionRef = useRef<BeziSession | null>(null);
  const activeSessionUpdatedAt = useRef<string | null>(null);
  const lastActiveEventAt = useRef(0);
  const pendingRevisionVerification = useRef<string | null>(null);
  const pendingLoadSessionId = useRef<string | null>(null);
  const replayBuffer = useRef<ChatEntry[] | null>(null);
  const replayClearsOnEmpty = useRef(false);
  const messagesRef = useRef<ChatEntry[]>([]);
  const agentStatusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timelineRef = useRef<ScrollView>(null);
  const timelinePinned = useRef(true);
  const previousDesktopWorkspaceId = useRef<string | null>(null);
  const previousDesktopProjectId = useRef<string | null>(null);
  const launchStateRef = useRef(launchState);
  const remoteStream = useRemoteStream("bezi");
  const showAgentStatus = useCallback((status: BeziAgentStatus | null) => {
    if (agentStatusTimer.current) {
      clearTimeout(agentStatusTimer.current);
      agentStatusTimer.current = null;
    }
    setAgentStatus(status);
    if (status) {
      agentStatusTimer.current = setTimeout(
        () => {
          agentStatusTimer.current = null;
          setAgentStatus(null);
        },
        status.active ? 12_000 : 3_500,
      );
    }
  }, []);
  const workspace = useMemo(
    () => parseWorkspace(capabilities?.body, catalog),
    [capabilities, catalog],
  );
  const selectedWorkspace =
    workspace.workspaces.find((value) => value.id === selectedWorkspaceId) ??
    workspace.workspaces.find((value) => value.id === workspace.activeWorkspaceId) ??
    workspace.workspaces[0] ??
    null;
  const selectedProject =
    selectedWorkspace?.projects.find(
      (project) => project.id === selectedProjectId,
    ) ??
    selectedWorkspace?.projects[0] ??
    null;
  const activeSession = sessions.find((session) => session.id === activeSessionId);
  const projectSessions = useMemo(
    () =>
      sessions.filter(
        (session) =>
          !selectedProject ||
          session.projectId === selectedProject.id ||
          session.cwd === selectedProject.path,
      ),
    [selectedProject, sessions],
  );
  const visiblePages = useMemo(
    () =>
      applyWorkspaceFolderState(
        selectedWorkspace?.pages ?? [],
        folderExpansionOverrides,
      ),
    [folderExpansionOverrides, selectedWorkspace?.pages],
  );
  const launchWorkspace =
    workspace.workspaces.find(
      (candidate) => candidate.id === launchState.workspaceId,
    ) ?? null;

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    launchStateRef.current = launchState;
  }, [launchState]);

  useEffect(() => {
    dispatchLaunch({ type: connected ? "connected" : "disconnected" });
  }, [connected]);

  useEffect(() => {
    if (
      launchState.phase !== "connecting" &&
      launchState.phase !== "loading-workspaces" &&
      launchState.phase !== "loading-threads" &&
      launchState.phase !== "loading-thread"
    ) {
      return;
    }
    const timer = setTimeout(() => dispatchLaunch({ type: "slow" }), 10_000);
    return () => clearTimeout(timer);
  }, [launchState.phase]);

  useEffect(
    () => () => {
      if (agentStatusTimer.current) clearTimeout(agentStatusTimer.current);
    },
    [],
  );

  useEffect(() => {
    const desktopWorkspaceId = workspace.activeWorkspaceId;
    const previousDesktopId = previousDesktopWorkspaceId.current;
    setSelectedWorkspaceId((current) => {
      const currentStillExists = workspace.workspaces.some(
        (value) => value.id === current,
      );
      if (!currentStillExists || current === previousDesktopId) {
        return desktopWorkspaceId ?? workspace.workspaces[0]?.id ?? null;
      }
      return current;
    });
    previousDesktopWorkspaceId.current = desktopWorkspaceId;
  }, [workspace.activeWorkspaceId, workspace.workspaces]);

  useEffect(() => {
    const desktopProjectId = selectedWorkspace?.activeProjectId ?? null;
    const previousDesktopId = previousDesktopProjectId.current;
    setSelectedProjectId((current) => {
      const currentStillExists =
        selectedWorkspace?.projects.some((value) => value.id === current) ?? false;
      if (!currentStillExists || current === previousDesktopId) {
        return desktopProjectId ?? selectedWorkspace?.projects[0]?.id ?? null;
      }
      return current;
    });
    previousDesktopProjectId.current = desktopProjectId;
  }, [selectedWorkspace]);

  useEffect(() => {
    if (!connected) {
      // Returning from the background intentionally replaces the relay
      // connection. Keep the populated workspace and thread view while that
      // brief reconnect happens, then let the foreground refresh reconcile it.
      lastActiveEventAt.current = 0;
      pendingRevisionVerification.current = null;
      pendingLoadSessionId.current = null;
      replayBuffer.current = null;
      replayClearsOnEmpty.current = false;
      newRequest.current = null;
      promptRequest.current = null;
      loadRequest.current = null;
      showAgentStatus(null);
      setPermission(null);
      setSessionBusy(false);
      listRequest.current = null;
      catalogRequest.current = null;
      folderRequest.current = null;
      setFolderBusyId(null);
    }
  }, [connected, showAgentStatus]);

  useEffect(() => {
    const cwd = selectedProject?.path;
    const shouldList =
      launchState.phase === "loading-threads" || launchState.phase === "ready";
    if (!connected || !cwd || !shouldList) return;
    listRequest.current = null;
    const refresh = () => {
      if (listRequest.current) return;
      listRequest.current = send(
        "bezi.session.list",
        { cwd },
        { kind: "signaling" },
      );
    };
    refresh();
    const timer = setInterval(refresh, 3_000);
    const appState = AppState.addEventListener("change", (state) => {
      if (state === "active") refresh();
    });
    return () => {
      clearInterval(timer);
      appState.remove();
      listRequest.current = null;
    };
  }, [connected, launchState.phase, selectedProject?.path, send]);

  useEffect(() => {
    const shouldLoadCatalog =
      launchState.phase === "loading-workspaces" || launchState.phase === "ready";
    if (!connected || !shouldLoadCatalog) return;
    const refresh = () => {
      if (catalogRequest.current) return;
      catalogRequest.current = send(
        "bezi.catalog.get",
        {},
        { kind: "signaling" },
      );
    };
    refresh();
    const timer = setInterval(refresh, 5_000);
    const appState = AppState.addEventListener("change", (state) => {
      if (state === "active") refresh();
    });
    return () => {
      clearInterval(timer);
      appState.remove();
      catalogRequest.current = null;
    };
  }, [connected, launchState.phase, send]);

  useEffect(() => {
    if (
      !connected ||
      !activeSessionId ||
      launchState.phase !== "ready"
    ) {
      return;
    }
    const synchronize = () => {
      const session = activeSessionRef.current;
      if (!session || loadRequest.current || promptRequest.current) return;
      openSession(
        session,
        send,
        loadRequest,
        pendingLoadSessionId,
        replayBuffer,
        replayClearsOnEmpty,
        setSessionBusy,
        false,
        false,
      );
    };
    const timer = setInterval(synchronize, 2_500);
    const appState = AppState.addEventListener("change", (state) => {
      if (state === "active") synchronize();
    });
    return () => {
      clearInterval(timer);
      appState.remove();
    };
  }, [activeSessionId, connected, launchState.phase, send]);

  useEffect(() => {
    if (
      !connected ||
      launchState.phase !== "loading-thread" ||
      loadRequest.current
    ) {
      return;
    }
    const session = activeSessionRef.current;
    if (!session) {
      dispatchLaunch({
        type: "failed",
        operation: "thread",
        message: "Bezi could not find the newest thread to open.",
      });
      return;
    }
    const requestId = openSession(
      session,
      send,
      loadRequest,
      pendingLoadSessionId,
      replayBuffer,
      replayClearsOnEmpty,
      setSessionBusy,
      true,
      true,
    );
    if (!requestId) {
      dispatchLaunch({
        type: "failed",
        operation: "thread",
        message: "Bezi could not start loading the newest thread.",
      });
    }
  }, [connected, launchState.phase, send]);

  useEffect(
    () =>
      subscribe((payload) => {
        if (!payload.type.startsWith("bezi.")) return;
        if (
          payload.type === "bezi.catalog" &&
          (!catalogRequest.current || payload.requestId === catalogRequest.current)
        ) {
          catalogRequest.current = null;
          const nextCatalog = asRecord(payload.body.workspace);
          setCatalog(nextCatalog);
          if (launchStateRef.current.phase === "loading-workspaces") {
            const nextWorkspace = parseWorkspace(capabilities?.body, nextCatalog);
            if (nextWorkspace.workspaces.length === 0) {
              dispatchLaunch({
                type: "failed",
                operation: "catalog",
                message: "No Bezi workspaces were found. Check the desktop app and try again.",
              });
            } else {
              dispatchLaunch({ type: "catalog-ready" });
            }
          }
          return;
        }
        if (
          payload.type === "bezi.ui.folder.changed" &&
          payload.requestId === folderRequest.current
        ) {
          folderRequest.current = null;
          setFolderBusyId(null);
          catalogRequest.current = send(
            "bezi.catalog.get",
            {},
            { kind: "signaling" },
          );
          return;
        }

        const envelope = asRecord(payload.body.message);
        if (payload.type === "bezi.error") {
          const catalogFailed = payload.requestId === catalogRequest.current;
          const listFailed = payload.requestId === listRequest.current;
          const loadFailed = payload.requestId === loadRequest.current;
          const folderFailed = payload.requestId === folderRequest.current;
          if (catalogFailed) {
            catalogRequest.current = null;
          }
          if (listFailed) {
            listRequest.current = null;
          }
          if (loadFailed) {
            loadRequest.current = null;
            pendingLoadSessionId.current = null;
            replayBuffer.current = null;
            replayClearsOnEmpty.current = false;
          }
          if (folderFailed) {
            folderRequest.current = null;
            setFolderBusyId(null);
          }
          setSessionBusy(false);
          if (folderFailed) return;
          const message =
            stringValue(payload.body.message) ?? "Bezi rejected the request.";
          if (launchStateRef.current.phase !== "ready") {
            if (catalogFailed) {
              dispatchLaunch({
                type: "failed",
                operation: "catalog",
                message: "Bezi could not load your workspaces.",
              });
              return;
            }
            if (listFailed) {
              dispatchLaunch({
                type: "failed",
                operation: "threads",
                message: "Bezi could not load this project's threads.",
              });
              return;
            }
            if (loadFailed) {
              dispatchLaunch({
                type: "failed",
                operation: "thread",
                message: "Bezi could not open the newest thread.",
              });
              return;
            }
          }
          setError(message);
          return;
        }
        if (!envelope) return;

        if (payload.requestId === newRequest.current) {
          newRequest.current = null;
          setSessionBusy(false);
          const result = asRecord(envelope.result);
          const sessionId = stringValue(result?.sessionId);
          if (sessionId) {
            const session = {
              id: sessionId,
              title: "New thread",
              cwd: selectedProject?.path,
              projectId: selectedProject?.id,
              projectLabel: selectedProject?.label,
              workspaceId: selectedWorkspace?.id,
            };
            activeSessionIdRef.current = sessionId;
            activeSessionRef.current = session;
            activeSessionUpdatedAt.current = null;
            pendingRevisionVerification.current = null;
            setActiveSessionId(sessionId);
            timelinePinned.current = true;
            messagesRef.current = [];
            setMessages([]);
            setSessions((current) => [
              session,
              ...current.filter((session) => session.id !== sessionId),
            ]);
            applyAdvertisedChoices(result, setChoices);
          }
          return;
        }

        if (payload.requestId === listRequest.current) {
          listRequest.current = null;
          const result = asRecord(envelope.result);
          if (envelope.error) {
            if (launchStateRef.current.phase === "loading-threads") {
              dispatchLaunch({
                type: "failed",
                operation: "threads",
                message: "Bezi could not load this project's threads.",
              });
            } else {
              setError("Bezi could not list this project's live threads.");
            }
            return;
          }
          const liveSessions = parseBeziSessions(result?.sessions).map((session) => {
            const project =
              selectedWorkspace?.projects.find(
                (value) => value.path === session.cwd,
              ) ??
              selectedProject;
            return {
              ...session,
              projectId: project?.id,
              projectLabel: project?.label,
              workspaceId: selectedWorkspace?.id,
            };
          });
          const cwd = selectedProject?.path;
          setSessions((current) =>
            [
              ...current.filter((session) => !cwd || session.cwd !== cwd),
              ...liveSessions,
            ].sort((left, right) =>
              String(right.updatedAt ?? "").localeCompare(
                String(left.updatedAt ?? ""),
              ),
            ),
          );

          if (launchStateRef.current.phase === "loading-threads") {
            const first = liveSessions[0];
            activeSessionIdRef.current = first?.id ?? null;
            activeSessionRef.current = first ?? null;
            activeSessionUpdatedAt.current = first?.updatedAt ?? null;
            pendingRevisionVerification.current = null;
            setActiveSessionId(first?.id ?? null);
            timelinePinned.current = true;
            messagesRef.current = [];
            setMessages([]);
            setSessionBusy(Boolean(first));
            dispatchLaunch({
              type: first ? "threads-ready" : "threads-empty",
            });
            return;
          }

          const activeId = activeSessionIdRef.current;
          const activeLiveSession = liveSessions.find(
            (session) => session.id === activeId,
          );
          const unsavedNewSession =
            Boolean(activeId) &&
            activeSessionRef.current?.id === activeId &&
            !activeSessionRef.current.updatedAt;
          if (!activeId || (!activeLiveSession && !unsavedNewSession)) {
            const first = liveSessions[0];
            activeSessionIdRef.current = first?.id ?? null;
            activeSessionRef.current = first ?? null;
            activeSessionUpdatedAt.current = first?.updatedAt ?? null;
            pendingRevisionVerification.current = null;
            setActiveSessionId(first?.id ?? null);
            timelinePinned.current = true;
            messagesRef.current = [];
            setMessages([]);
            if (first) {
              openSession(
                first,
                send,
                loadRequest,
                pendingLoadSessionId,
                replayBuffer,
                replayClearsOnEmpty,
                setSessionBusy,
                true,
                true,
              );
            } else {
              pendingLoadSessionId.current = null;
              setSessionBusy(false);
            }
          } else if (activeLiveSession) {
            const previousRevision = activeSessionUpdatedAt.current;
            const nextRevision = activeLiveSession.updatedAt ?? null;
            activeSessionRef.current = activeLiveSession;
            activeSessionUpdatedAt.current = nextRevision;
            const syncDecision = decideBeziHistorySync({
              previousRevision,
              nextRevision,
              pendingRevision: pendingRevisionVerification.current,
              lastLiveEventAt: lastActiveEventAt.current,
              now: Date.now(),
            });
            pendingRevisionVerification.current =
              syncDecision.pendingRevision;
            if (syncDecision.action === "reconcile" && !loadRequest.current) {
              openSession(
                activeLiveSession,
                send,
                loadRequest,
                pendingLoadSessionId,
                replayBuffer,
                replayClearsOnEmpty,
                setSessionBusy,
                false,
                false,
              );
            }
          }
          return;
        }

        if (payload.requestId === loadRequest.current) {
          const isInitialThreadLoad =
            launchStateRef.current.phase === "loading-thread";
          loadRequest.current = null;
          pendingLoadSessionId.current = null;
          const replay = replayBuffer.current;
          const clearOnEmpty = replayClearsOnEmpty.current;
          replayBuffer.current = null;
          replayClearsOnEmpty.current = false;
          setSessionBusy(false);
          if (envelope.error) {
            if (isInitialThreadLoad) {
              dispatchLaunch({
                type: "failed",
                operation: "thread",
                message: "Bezi could not open the newest thread.",
              });
            } else {
              setError("Bezi could not load this thread.");
            }
            return;
          }
          const result = asRecord(envelope.result);
          applyAdvertisedChoices(result, setChoices);
          const history = parseLoadedBeziHistory(result);
          const synchronizedHistory = resolveBeziHistoryReconciliation(
            history,
            replay ?? [],
            clearOnEmpty,
          );
          if (
            synchronizedHistory &&
            !areBeziHistoriesEqual(messagesRef.current, synchronizedHistory)
          ) {
            messagesRef.current = synchronizedHistory;
            setMessages(synchronizedHistory);
          }
          showAgentStatus(null);
          if (isInitialThreadLoad) {
            dispatchLaunch({ type: "thread-ready" });
          }
          return;
        }

        if (payload.requestId === promptRequest.current) {
          promptRequest.current = null;
          showAgentStatus(null);
          return;
        }

        if (envelope.method === "bezi_remote/initialized") {
          const session = activeSessionRef.current;
          if (
            launchStateRef.current.phase === "ready" &&
            session &&
            !loadRequest.current
          ) {
            openSession(
              session,
              send,
              loadRequest,
              pendingLoadSessionId,
              replayBuffer,
              replayClearsOnEmpty,
              setSessionBusy,
              false,
              false,
            );
          }
          return;
        }

        if (envelope.method === "session/request_permission" && envelope.id !== undefined) {
          const params = asRecord(envelope.params);
          const toolCall = asRecord(params?.toolCall);
          const options = Array.isArray(params?.options)
            ? params.options
                .map(asRecord)
                .filter((value): value is Record<string, unknown> => value !== null)
                .filter(
                  (value) =>
                    typeof value.optionId === "string" &&
                    typeof value.name === "string",
                )
                .map((value) => ({
                  optionId: value.optionId as string,
                  name: value.name as string,
                  kind: stringValue(value.kind) ?? undefined,
                }))
            : [];
          setPermission({
            requestId: envelope.id,
            title: stringValue(toolCall?.title) ?? "Bezi needs your approval",
            options,
          });
          return;
        }

        if (envelope.method !== "session/update") return;
        const params = asRecord(envelope.params);
        const update = asRecord(params?.update);
        if (!update) return;
        const sessionId = stringValue(params?.sessionId);
        const expectedSessionId =
          pendingLoadSessionId.current ?? activeSessionIdRef.current;
        if (sessionId && expectedSessionId && sessionId !== expectedSessionId) return;
        const updateKind =
          stringValue(update.sessionUpdate) ?? stringValue(update.type);
        if (updateKind === "session_info_update" && sessionId) {
          const title = stringValue(update.title);
          const updatedAt = stringValue(update.updatedAt);
          setSessions((current) =>
            current.map((session) =>
              session.id === sessionId
                ? {
                    ...session,
                    title: title ?? session.title,
                    updatedAt: updatedAt ?? session.updatedAt,
                  }
                : session,
            ),
          );
          if (activeSessionRef.current?.id === sessionId) {
            activeSessionRef.current = {
              ...activeSessionRef.current,
              title: title ?? activeSessionRef.current.title,
              updatedAt: updatedAt ?? activeSessionRef.current.updatedAt,
            };
            if (updatedAt) activeSessionUpdatedAt.current = updatedAt;
          }
          lastActiveEventAt.current = Date.now();
          return;
        }
        if (replayBuffer.current) {
          replayBuffer.current = reduceBeziSessionUpdate(
            replayBuffer.current,
            update,
          );
        } else {
          lastActiveEventAt.current = Date.now();
          const status = statusFromBeziUpdate(update);
          if (status) showAgentStatus(status);
          setMessages((current) => reduceBeziSessionUpdate(current, update));
        }
      }),
    [
      capabilities,
      selectedProject,
      selectedWorkspace,
      send,
      showAgentStatus,
      subscribe,
    ],
  );

  const startThread = () => {
    if (!selectedProject || !hasControl || sessionBusy) return;
    setSessionBusy(true);
    setError(null);
    newRequest.current = send("bezi.session.new", {
      cwd: selectedProject.path,
      mcpServers: [],
    });
    setDestination("threads");
    setDrawerOpen(false);
  };

  const selectSession = (session: BeziSession) => {
    setDestination("threads");
    activeSessionIdRef.current = session.id;
    activeSessionRef.current = session;
    activeSessionUpdatedAt.current = session.updatedAt ?? null;
    lastActiveEventAt.current = 0;
    pendingRevisionVerification.current = null;
    setActiveSessionId(session.id);
    timelinePinned.current = true;
    messagesRef.current = [];
    setMessages([]);
    setError(null);
    showAgentStatus(null);
    if (session.workspaceId) setSelectedWorkspaceId(session.workspaceId);
    if (session.projectId) setSelectedProjectId(session.projectId);
    openSession(
      session,
      send,
      loadRequest,
      pendingLoadSessionId,
      replayBuffer,
      replayClearsOnEmpty,
      setSessionBusy,
      true,
      true,
    );
    setDrawerOpen(false);
  };

  const submitPrompt = () => {
    const text = composer.trim();
    if (!text || !connected || !activeSessionId) return;
    const requestId = send("bezi.session.prompt", {
      sessionId: activeSessionId,
      text,
      attachments: [],
    });
    if (!requestId) return;
    promptRequest.current = requestId;
    showAgentStatus({ label: "Thinking", active: true });
    setMessages((current) => [...current, { id: requestId, role: "user", text }]);
    setComposer("");
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const selectChoice = (kind: "mode" | "model", choice: AdvertisedChoice) => {
    if (!activeSessionId || !hasControl) return;
    send(`bezi.session.set_${kind}`, {
      sessionId: activeSessionId,
      [`${kind}Id`]: choice.id,
    });
    setChoices((current) => ({ ...current, [kind]: choice.id }));
    setChoicePicker(null);
    void Haptics.selectionAsync();
  };

  const openWorkspaceItem = (item: WorkspaceItem) => {
    if (!hasControl) return;
    send("bezi.ui.activate", { itemId: item.id });
    setRemoteTitle(decodeHtml(item.title));
    setDestination("remote");
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const toggleWorkspaceFolder = (item: WorkspaceItem) => {
    if (item.kind !== "folder" || folderRequest.current) {
      return;
    }
    if (!item.remote) {
      setFolderExpansionOverrides((current) => ({
        ...current,
        [item.id]: !item.expanded,
      }));
      void Haptics.selectionAsync();
      return;
    }
    if (!hasControl) return;
    const requestId = send("bezi.ui.folder.set", {
      itemId: item.id,
      expanded: !item.expanded,
    });
    if (!requestId) return;
    folderRequest.current = requestId;
    setFolderBusyId(item.id);
    void Haptics.selectionAsync();
  };

  const chooseLaunchWorkspace = (candidate: BeziWorkspace) => {
    setSelectedWorkspaceId(candidate.id);
    setSelectedProjectId(null);
    dispatchLaunch({
      type: "choose-workspace",
      workspaceId: candidate.id,
    });
    void Haptics.selectionAsync();
  };

  const chooseLaunchProject = (project: WorkspaceProject) => {
    setSelectedWorkspaceId(launchWorkspace?.id ?? null);
    setSelectedProjectId(project.id);
    setSessions([]);
    setActiveSessionId(null);
    activeSessionIdRef.current = null;
    activeSessionRef.current = null;
    activeSessionUpdatedAt.current = null;
    pendingRevisionVerification.current = null;
    pendingLoadSessionId.current = null;
    messagesRef.current = [];
    setMessages([]);
    setError(null);
    dispatchLaunch({ type: "choose-project", projectId: project.id });
    void Haptics.selectionAsync();
  };

  const retryLaunch = () => {
    setError(null);
    dispatchLaunch({ type: "retry" });
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  if (isBeziLaunchPending(launchState)) {
    return (
      <LaunchWizard
        onBack={() => {
          dispatchLaunch({ type: "back-to-workspaces" });
          void Haptics.selectionAsync();
        }}
        onChooseProject={chooseLaunchProject}
        onChooseWorkspace={chooseLaunchWorkspace}
        onRetry={retryLaunch}
        state={launchState}
        workspace={launchWorkspace}
        workspaces={workspace.workspaces}
      />
    );
  }

  const createDisabled = !connected || !hasControl || !selectedProject;
  const sendDisabled =
    !composer.trim() || !connected || !activeSessionId;

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={0}
      style={styles.flex}
    >
      <SafeAreaView edges={["top"]} style={styles.safe}>
        <MobileHeader
          connected={connected}
          disabled={destination === "threads" && createDisabled}
          onMenu={() => setDrawerOpen(true)}
          onPrimary={() => {
            if (destination === "threads") startThread();
            else {
              setRemoteTitle("Full Remote");
              setDestination("remote");
            }
          }}
          primaryIcon={
            destination === "threads" ? "square-edit-outline" : "monitor-share"
          }
          project={selectedProject?.label ?? "Bezi workspace"}
          title={
            destination === "threads"
              ? activeSession?.title ?? "New thread"
              : destination === "remote"
                ? remoteTitle
                : destinationLabel(destination)
          }
        />

        <ControlStrip
          connected={connected}
          hasControl={hasControl}
          onRelease={releaseControl}
          onTake={() => takeControl(30)}
        />

        {destination === "threads" ? (
          <View style={styles.threadScreen}>
            {error ? (
              <View style={styles.inlineError}>
                <MaterialCommunityIcons
                  color={colors.danger}
                  name="alert-circle-outline"
                  size={18}
                />
                <Text style={styles.errorText}>{error}</Text>
              </View>
            ) : null}

            <ScrollView
              contentContainerStyle={styles.timeline}
              keyboardDismissMode="interactive"
              keyboardShouldPersistTaps="handled"
              onContentSizeChange={() => {
                if (timelinePinned.current) {
                  timelineRef.current?.scrollToEnd({ animated: true });
                }
              }}
              onScroll={({ nativeEvent }) => {
                const distanceFromEnd =
                  nativeEvent.contentSize.height -
                  nativeEvent.layoutMeasurement.height -
                  nativeEvent.contentOffset.y;
                timelinePinned.current = distanceFromEnd < 96;
              }}
              ref={timelineRef}
              scrollEventThrottle={100}
              showsVerticalScrollIndicator={false}
              style={styles.timelineScroll}
            >
              {!connected ? (
                <EmptyState
                  copy="Connect the Windows companion to see the real threads and projects from Bezi."
                  icon="desktop-tower-monitor"
                  title="Your Bezi workspace is offline"
                />
              ) : !activeSessionId ? (
                <EmptyState
                  copy="Choose a project from the menu, take control, and create a thread."
                  icon="message-plus-outline"
                  title="Start a thread"
                />
              ) : messages.length === 0 ? (
                <EmptyState
                  copy="Prompt Bezi below. Responses, plans, tools, diffs, and approvals appear here."
                  icon="message-processing-outline"
                  title={sessionBusy ? "Loading thread…" : "What are we building?"}
                />
              ) : (
                messages.map((entry) => (
                  <MessageCard
                    entry={entry}
                    key={entry.id}
                    onOpenDiff={setSelectedDiff}
                  />
                ))
              )}

              {agentStatus ? (
                <View
                  accessibilityLabel={[
                    `Bezi is ${agentStatus.label.toLowerCase()}`,
                    agentStatus.detail,
                  ]
                    .filter(Boolean)
                    .join(". ")}
                  accessibilityLiveRegion="polite"
                  style={styles.agentStatus}
                >
                  <View style={styles.agentStatusIndicator}>
                    {agentStatus.active ? (
                      <ActivityIndicator color={colors.primaryStrong} size="small" />
                    ) : (
                      <MaterialCommunityIcons
                        color={colors.live}
                        name="check"
                        size={15}
                      />
                    )}
                  </View>
                  <View style={styles.grow}>
                    <Text style={styles.agentStatusLabel}>
                      {agentStatus.label}
                      {agentStatus.active ? "…" : ""}
                    </Text>
                    {agentStatus.detail ? (
                      <Text numberOfLines={1} style={styles.agentStatusDetail}>
                        {agentStatus.detail}
                      </Text>
                    ) : null}
                  </View>
                  <View style={styles.agentStatusLive}>
                    <View style={styles.agentStatusDot} />
                    <Text style={styles.agentStatusLiveText}>LIVE</Text>
                  </View>
                </View>
              ) : null}

              {permission ? (
                <Card elevated style={styles.permissionCard}>
                  <View style={styles.row}>
                    <View style={styles.permissionIcon}>
                      <MaterialCommunityIcons
                        color={colors.warning}
                        name="shield-key-outline"
                        size={20}
                      />
                    </View>
                    <View style={styles.grow}>
                      <Text style={styles.cardTitle}>Approval requested</Text>
                      <Text style={styles.cardMeta}>{permission.title}</Text>
                    </View>
                  </View>
                  <View style={styles.permissionActions}>
                    {permission.options.map((option) => (
                      <ActionButton
                        key={option.optionId}
                        label={option.name}
                        onPress={() => {
                          send("bezi.permission.resolve", {
                            acpRequestId: permission.requestId,
                            option: option.optionId,
                          });
                          setPermission(null);
                        }}
                        style={styles.grow}
                        variant={
                          option.kind?.includes("reject") ? "ghost" : "primary"
                        }
                      />
                    ))}
                  </View>
                </Card>
              ) : null}
            </ScrollView>

            <View style={styles.composerDock}>
              <View style={styles.composer}>
                <TextInput
                  accessibilityLabel="Message Bezi"
                  editable={connected && Boolean(activeSessionId)}
                  multiline
                  onChangeText={setComposer}
                  placeholder={
                    activeSessionId ? "Message Bezi" : "Open a thread to start prompting"
                  }
                  placeholderTextColor={colors.textMuted}
                  style={styles.composerInput}
                  value={composer}
                />
                <View style={styles.composerFooter}>
                  <Pressable
                    accessibilityLabel="Attach an image"
                    accessibilityRole="button"
                    disabled
                    style={styles.composerRoundButton}
                  >
                    <MaterialCommunityIcons
                      color={colors.textMuted}
                      name="plus"
                      size={22}
                    />
                  </Pressable>
                  <View style={styles.composerChoices}>
                    {choices.modes.length > 0 ? (
                      <ComposerChoice
                        icon="robot-outline"
                        label={choiceDisplayName(
                          choices.modes,
                          choices.mode,
                          "Mode",
                        )}
                        onPress={() => setChoicePicker("mode")}
                        primary
                      />
                    ) : null}
                    {choices.models.length > 0 ? (
                      <ComposerChoice
                        label={choiceDisplayName(
                          choices.models,
                          choices.model,
                          "Model",
                        )}
                        onPress={() => setChoicePicker("model")}
                      />
                    ) : null}
                  </View>
                  <Pressable
                    accessibilityLabel="Send prompt"
                    accessibilityRole="button"
                    disabled={sendDisabled}
                    onPress={submitPrompt}
                    style={[
                      styles.sendButton,
                      sendDisabled && styles.sendButtonDisabled,
                    ]}
                  >
                    <MaterialCommunityIcons
                      color={sendDisabled ? colors.textMuted : colors.primaryInk}
                      name="arrow-up"
                      size={20}
                    />
                  </Pressable>
                </View>
              </View>
            </View>
          </View>
        ) : (
          <ScrollView
            contentContainerStyle={styles.workspaceScroll}
            showsVerticalScrollIndicator={false}
          >
            <WorkspaceView
              canvases={selectedWorkspace?.canvases ?? []}
              destination={destination}
              folderBusyId={folderBusyId}
              hasControl={hasControl}
              navigation={selectedWorkspace?.navigation ?? []}
              onOpen={openWorkspaceItem}
              onToggleFolder={toggleWorkspaceFolder}
              pages={visiblePages}
              remoteStream={remoteStream}
              skills={workspace.skills}
            />
          </ScrollView>
        )}
      </SafeAreaView>

      <WorkspaceDrawer
        activeDestination={destination}
        activeSessionId={activeSessionId}
        connected={connected}
        hasControl={hasControl}
        onChooseWorkspace={() => {
          setDrawerOpen(false);
          setWorkspacePickerOpen(true);
        }}
        onChooseProject={() => {
          setDrawerOpen(false);
          setProjectPickerOpen(true);
        }}
        onClose={() => setDrawerOpen(false)}
        onNewThread={startThread}
        onRelease={releaseControl}
        onSelectDestination={(next) => {
          if (next === "remote") setRemoteTitle("Full Remote");
          setDestination(next);
          setDrawerOpen(false);
        }}
        onSelectSession={selectSession}
        onTake={() => takeControl(30)}
        open={drawerOpen}
        project={selectedProject}
        sessions={projectSessions}
        workspace={selectedWorkspace}
      />

      <BottomSheet
        onClose={() => setWorkspacePickerOpen(false)}
        open={workspacePickerOpen}
        title="Bezi workspaces"
      >
        {workspace.workspaces.length === 0 ? (
          <Text style={styles.sheetEmpty}>No Bezi workspaces were found.</Text>
        ) : (
          workspace.workspaces.map((candidate) => {
            const selected = candidate.id === selectedWorkspace?.id;
            return (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected }}
                key={candidate.id}
                onPress={() => {
                  setSelectedWorkspaceId(candidate.id);
                  setSelectedProjectId(
                    candidate.activeProjectId ?? candidate.projects[0]?.id ?? null,
                  );
                  setWorkspacePickerOpen(false);
                }}
                style={[styles.pickerRow, selected && styles.pickerRowActive]}
              >
                <MaterialCommunityIcons
                  color={selected ? colors.primaryStrong : colors.textMuted}
                  name="view-grid-outline"
                  size={20}
                />
                <View style={styles.grow}>
                  <Text numberOfLines={1} style={styles.pickerTitle}>
                    {candidate.label}
                  </Text>
                  <Text numberOfLines={1} style={styles.pickerMeta}>
                    {candidate.projects.length} connection
                    {candidate.projects.length === 1 ? "" : "s"}
                    {candidate.isActive ? " · Active on desktop" : ""}
                  </Text>
                </View>
                {selected ? (
                  <MaterialCommunityIcons
                    color={colors.primaryStrong}
                    name="check"
                    size={20}
                  />
                ) : null}
              </Pressable>
            );
          })
        )}
      </BottomSheet>

      <BottomSheet
        onClose={() => setProjectPickerOpen(false)}
        open={projectPickerOpen}
        title={`${selectedWorkspace?.label ?? "Bezi"} projects`}
      >
        {!selectedWorkspace || selectedWorkspace.projects.length === 0 ? (
          <Text style={styles.sheetEmpty}>No Bezi projects were found.</Text>
        ) : (
          selectedWorkspace.projects.map((project) => (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: project.id === selectedProject?.id }}
              key={project.id}
              onPress={() => {
                setSelectedProjectId(project.id);
                setProjectPickerOpen(false);
              }}
              style={[
                styles.pickerRow,
                project.id === selectedProject?.id && styles.pickerRowActive,
              ]}
            >
              <MaterialCommunityIcons
                color={colors.primary}
                name="folder-outline"
                size={20}
              />
              <View style={styles.grow}>
                <Text numberOfLines={1} style={styles.pickerTitle}>
                  {project.label}
                </Text>
                <Text numberOfLines={1} style={styles.pickerMeta}>
                  {project.path}
                </Text>
              </View>
              {project.id === selectedProject?.id ? (
                <MaterialCommunityIcons
                  color={colors.primaryStrong}
                  name="check"
                  size={20}
                />
              ) : null}
            </Pressable>
          ))
        )}
      </BottomSheet>

      <BottomSheet
        onClose={() => setChoicePicker(null)}
        open={choicePicker !== null}
        title={choicePicker === "mode" ? "Choose mode" : "Choose model"}
      >
        {(choicePicker === "mode" ? choices.modes : choices.models).map(
          (choice) => {
            const selected =
              choice.id ===
              (choicePicker === "mode" ? choices.mode : choices.model);
            return (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected }}
                key={choice.id}
                onPress={() => choicePicker && selectChoice(choicePicker, choice)}
                style={[styles.pickerRow, selected && styles.pickerRowActive]}
              >
                <MaterialCommunityIcons
                  color={selected ? colors.primaryStrong : colors.textMuted}
                  name={choicePicker === "mode" ? "robot-outline" : "memory"}
                  size={19}
                />
                <Text style={[styles.pickerTitle, styles.grow]}>{choice.name}</Text>
                {selected ? (
                  <MaterialCommunityIcons
                    color={colors.primaryStrong}
                    name="check"
                    size={20}
                  />
                ) : null}
              </Pressable>
            );
          },
        )}
      </BottomSheet>

      <DiffViewer file={selectedDiff} onClose={() => setSelectedDiff(null)} />
    </KeyboardAvoidingView>
  );
}

function LaunchWizard({
  onBack,
  onChooseProject,
  onChooseWorkspace,
  onRetry,
  state,
  workspace,
  workspaces,
}: {
  onBack: () => void;
  onChooseProject: (project: WorkspaceProject) => void;
  onChooseWorkspace: (workspace: BeziWorkspace) => void;
  onRetry: () => void;
  state: BeziLaunchState;
  workspace: BeziWorkspace | null;
  workspaces: BeziWorkspace[];
}) {
  const transition = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    let cancelled = false;
    void AccessibilityInfo.isReduceMotionEnabled().then((reduceMotion) => {
      if (cancelled || reduceMotion) {
        transition.setValue(1);
        return;
      }
      transition.setValue(0);
      Animated.timing(transition, {
        duration: 220,
        toValue: 1,
        useNativeDriver: Platform.OS !== "web",
      }).start();
    });
    return () => {
      cancelled = true;
      transition.stopAnimation();
    };
  }, [state.phase, transition]);

  const animatedStyle = {
    opacity: transition,
    transform: [
      {
        translateY: transition.interpolate({
          inputRange: [0, 1],
          outputRange: [10, 0],
        }),
      },
    ],
  };
  const status = launchStatus(state);
  const choosingWorkspace = state.phase === "choose-workspace";
  const choosingProject = state.phase === "choose-project";

  return (
    <SafeAreaView edges={["top", "bottom"]} style={styles.launchSafe}>
      <View style={styles.launchBrandRow}>
        <View style={styles.launchBrandMark}>
          <MaterialCommunityIcons
            color={colors.primaryStrong}
            name="robot-outline"
            size={22}
          />
        </View>
        <Text style={styles.launchBrand}>Bezi</Text>
      </View>

      <Animated.View style={[styles.launchAnimated, animatedStyle]}>
        {choosingWorkspace || choosingProject ? (
          <>
            <View style={styles.launchChoiceHeader}>
              {choosingProject ? (
                <Pressable
                  accessibilityLabel="Back to workspace selection"
                  accessibilityRole="button"
                  hitSlop={8}
                  onPress={onBack}
                  style={styles.launchBack}
                >
                  <MaterialCommunityIcons
                    color={colors.textSecondary}
                    name="arrow-left"
                    size={22}
                  />
                  <Text style={styles.launchBackText}>Back</Text>
                </Pressable>
              ) : (
                <View style={styles.launchBackPlaceholder} />
              )}
              <LaunchSteps projectActive={choosingProject} />
            </View>

            <View style={styles.launchHeading}>
              <Text style={styles.launchTitle}>
                {choosingWorkspace ? "Choose a workspace" : "Choose a project"}
              </Text>
              <Text style={styles.launchCopy}>
                {choosingWorkspace
                  ? "Pick the Bezi workspace you want to open on this device."
                  : `Choose what to open in ${workspace?.label ?? "this workspace"}.`}
              </Text>
            </View>

            <ScrollView
              contentContainerStyle={styles.launchChoices}
              showsVerticalScrollIndicator={false}
            >
              {choosingWorkspace
                ? workspaces.map((candidate) => {
                    const selected = candidate.id === state.workspaceId;
                    return (
                      <LaunchChoice
                        accessibilityLabel={`Choose ${candidate.label} workspace`}
                        icon="view-grid-outline"
                        key={candidate.id}
                        meta={`${candidate.projects.length} project${
                          candidate.projects.length === 1 ? "" : "s"
                        }${candidate.isActive ? " · Active on desktop" : ""}`}
                        onPress={() => onChooseWorkspace(candidate)}
                        selected={selected}
                        title={candidate.label}
                      />
                    );
                  })
                : workspace?.projects.map((project) => (
                    <LaunchChoice
                      accessibilityLabel={`Choose ${project.label} project`}
                      icon="folder-outline"
                      key={project.id}
                      meta={compactPath(project.path)}
                      onPress={() => onChooseProject(project)}
                      selected={project.id === state.projectId}
                      title={project.label}
                    />
                  ))}

              {choosingProject && (workspace?.projects.length ?? 0) === 0 ? (
                <View style={styles.launchEmpty}>
                  <MaterialCommunityIcons
                    color={colors.textMuted}
                    name="folder-open-outline"
                    size={30}
                  />
                  <Text style={styles.launchEmptyTitle}>No projects here yet</Text>
                  <Text style={styles.launchEmptyCopy}>
                    Choose another workspace or add a project from the desktop app.
                  </Text>
                </View>
              ) : null}
            </ScrollView>
          </>
        ) : state.phase === "error" ? (
          <View
            accessibilityLiveRegion="assertive"
            style={styles.launchStatus}
          >
            <View style={[styles.launchStatusIcon, styles.launchErrorIcon]}>
              <MaterialCommunityIcons
                color={colors.danger}
                name="alert-circle-outline"
                size={30}
              />
            </View>
            <Text style={styles.launchTitle}>We hit a snag</Text>
            <Text style={styles.launchCopy}>
              {state.error?.message ?? "Bezi could not finish loading."}
            </Text>
            <Pressable
              accessibilityRole="button"
              onPress={onRetry}
              style={({ pressed }) => [
                styles.launchRetry,
                pressed && styles.launchChoicePressed,
              ]}
            >
              <MaterialCommunityIcons
                color={colors.primaryInk}
                name="refresh"
                size={20}
              />
              <Text style={styles.launchRetryText}>Retry</Text>
            </Pressable>
          </View>
        ) : (
          <View accessibilityLiveRegion="polite" style={styles.launchStatus}>
            <View style={styles.launchStatusIcon}>
              <ActivityIndicator color={colors.primaryStrong} size="large" />
            </View>
            <Text style={styles.launchTitle}>{status.title}</Text>
            <Text style={styles.launchCopy}>{status.copy}</Text>
            <View style={styles.launchProgressTrack}>
              <View style={styles.launchProgressFill} />
            </View>
          </View>
        )}
      </Animated.View>
    </SafeAreaView>
  );
}

function LaunchSteps({ projectActive }: { projectActive: boolean }) {
  return (
    <View
      accessibilityLabel={`Step ${projectActive ? 2 : 1} of 2`}
      style={styles.launchSteps}
    >
      <View style={styles.launchStep}>
        <View style={[styles.launchStepDot, styles.launchStepDotActive]}>
          {projectActive ? (
            <MaterialCommunityIcons
              color={colors.primaryInk}
              name="check"
              size={12}
            />
          ) : (
            <Text style={styles.launchStepNumber}>1</Text>
          )}
        </View>
        <Text style={styles.launchStepTextActive}>Workspace</Text>
      </View>
      <View
        style={[
          styles.launchStepLine,
          projectActive && styles.launchStepLineActive,
        ]}
      />
      <View style={styles.launchStep}>
        <View
          style={[
            styles.launchStepDot,
            projectActive && styles.launchStepDotActive,
          ]}
        >
          <Text
            style={[
              styles.launchStepNumber,
              !projectActive && styles.launchStepNumberMuted,
            ]}
          >
            2
          </Text>
        </View>
        <Text
          style={[
            styles.launchStepText,
            projectActive && styles.launchStepTextActive,
          ]}
        >
          Project
        </Text>
      </View>
    </View>
  );
}

function LaunchChoice({
  accessibilityLabel,
  icon,
  meta,
  onPress,
  selected,
  title,
}: {
  accessibilityLabel: string;
  icon: keyof typeof MaterialCommunityIcons.glyphMap;
  meta: string;
  onPress: () => void;
  selected: boolean;
  title: string;
}) {
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.launchChoice,
        selected && styles.launchChoiceSelected,
        pressed && styles.launchChoicePressed,
      ]}
    >
      <View style={styles.launchChoiceIcon}>
        <MaterialCommunityIcons
          color={colors.primaryStrong}
          name={icon}
          size={25}
        />
      </View>
      <View style={styles.grow}>
        <Text numberOfLines={1} style={styles.launchChoiceTitle}>
          {title}
        </Text>
        <Text numberOfLines={1} style={styles.launchChoiceMeta}>
          {meta}
        </Text>
      </View>
      <MaterialCommunityIcons
        color={colors.textMuted}
        name="chevron-right"
        size={24}
      />
    </Pressable>
  );
}

function MobileHeader({
  connected,
  disabled,
  onMenu,
  onPrimary,
  primaryIcon,
  project,
  title,
}: {
  connected: boolean;
  disabled: boolean;
  onMenu: () => void;
  onPrimary: () => void;
  primaryIcon: keyof typeof MaterialCommunityIcons.glyphMap;
  project: string;
  title: string;
}) {
  return (
    <View style={styles.topBar}>
      <Pressable
        accessibilityLabel="Open Bezi workspace menu"
        accessibilityRole="button"
        onPress={onMenu}
        style={styles.topBarButton}
      >
        <MaterialCommunityIcons color={colors.text} name="menu" size={24} />
      </Pressable>
      <Pressable
        accessibilityLabel="Open Bezi workspace menu"
        accessibilityRole="button"
        onPress={onMenu}
        style={styles.topBarIdentity}
      >
        <View style={styles.projectLine}>
          <View
            style={[
              styles.liveDot,
              { backgroundColor: connected ? colors.live : colors.textMuted },
            ]}
          />
          <Text numberOfLines={1} style={styles.projectLineText}>
            {project}
          </Text>
          <MaterialCommunityIcons
            color={colors.textMuted}
            name="chevron-down"
            size={15}
          />
        </View>
        <Text numberOfLines={1} style={styles.topBarTitle}>
          {title}
        </Text>
      </Pressable>
      <Pressable
        accessibilityLabel={
          primaryIcon === "square-edit-outline"
            ? "Create a new Bezi thread"
            : "Open Full Remote"
        }
        accessibilityRole="button"
        disabled={disabled}
        onPress={onPrimary}
        style={[styles.topBarButton, disabled && styles.disabled]}
      >
        <MaterialCommunityIcons
          color={colors.text}
          name={primaryIcon}
          size={22}
        />
      </Pressable>
    </View>
  );
}

function ComposerChoice({
  icon,
  label,
  onPress,
  primary = false,
}: {
  icon?: keyof typeof MaterialCommunityIcons.glyphMap;
  label: string;
  onPress: () => void;
  primary?: boolean;
}) {
  return (
    <Pressable
      accessibilityLabel={`Choose ${label}`}
      accessibilityRole="button"
      onPress={onPress}
      style={styles.choiceButton}
    >
      {icon ? (
        <MaterialCommunityIcons
          color={primary ? colors.primaryStrong : colors.textMuted}
          name={icon}
          size={15}
        />
      ) : null}
      <Text
        numberOfLines={1}
        style={[
          styles.choiceButtonText,
          primary && styles.choiceButtonPrimaryText,
        ]}
      >
        {label}
      </Text>
      <MaterialCommunityIcons
        color={colors.textMuted}
        name="chevron-down"
        size={14}
      />
    </Pressable>
  );
}

function WorkspaceDrawer({
  activeDestination,
  activeSessionId,
  connected,
  hasControl,
  onChooseWorkspace,
  onChooseProject,
  onClose,
  onNewThread,
  onRelease,
  onSelectDestination,
  onSelectSession,
  onTake,
  open,
  project,
  sessions,
  workspace,
}: {
  activeDestination: BeziDestination;
  activeSessionId: string | null;
  connected: boolean;
  hasControl: boolean;
  onChooseWorkspace: () => void;
  onChooseProject: () => void;
  onClose: () => void;
  onNewThread: () => void;
  onRelease: () => void;
  onSelectDestination: (destination: BeziDestination) => void;
  onSelectSession: (session: BeziSession) => void;
  onTake: () => void;
  open: boolean;
  project: WorkspaceProject | null;
  sessions: BeziSession[];
  workspace: BeziWorkspace | null;
}) {
  return (
    <Modal
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
      transparent
      visible={open}
    >
      <Pressable onPress={onClose} style={styles.drawerBackdrop}>
        <Pressable onPress={() => undefined} style={styles.drawer}>
          <SafeAreaView edges={["top", "bottom"]} style={styles.drawerSafe}>
            <View style={styles.drawerHeader}>
              <View style={styles.beziMark}>
                <Text style={styles.beziMarkText}>B</Text>
              </View>
              <Text style={styles.drawerBrand}>Bezi</Text>
              <Pressable
                accessibilityLabel="Close workspace menu"
                accessibilityRole="button"
                onPress={onClose}
                style={styles.drawerClose}
              >
                <MaterialCommunityIcons
                  color={colors.textSecondary}
                  name="close"
                  size={22}
                />
              </Pressable>
            </View>

            <Pressable
              accessibilityLabel="Switch Bezi workspace"
              accessibilityRole="button"
              onPress={onChooseWorkspace}
              style={styles.drawerProject}
            >
              <MaterialCommunityIcons
                color={colors.textSecondary}
                name="view-grid-outline"
                size={19}
              />
              <View style={styles.grow}>
                <Text numberOfLines={1} style={styles.drawerProjectTitle}>
                  {workspace?.label ?? "Choose a workspace"}
                </Text>
                <Text numberOfLines={1} style={styles.drawerProjectPath}>
                  {workspace
                    ? `${workspace.projects.length} connection${
                        workspace.projects.length === 1 ? "" : "s"
                      }${workspace.isActive ? " · Active on desktop" : ""}`
                    : "No workspace connected"}
                </Text>
              </View>
              <MaterialCommunityIcons
                color={colors.textMuted}
                name="unfold-more-horizontal"
                size={18}
              />
            </Pressable>

            <Pressable
              accessibilityLabel="Switch Bezi project"
              accessibilityRole="button"
              onPress={onChooseProject}
              style={[styles.drawerProject, styles.drawerProjectSecondary]}
            >
              <MaterialCommunityIcons
                color={colors.textSecondary}
                name="folder-outline"
                size={19}
              />
              <View style={styles.grow}>
                <Text numberOfLines={1} style={styles.drawerProjectTitle}>
                  {project?.label ?? "Choose a project"}
                </Text>
                <Text numberOfLines={1} style={styles.drawerProjectPath}>
                  {project?.path ?? "No project connected"}
                </Text>
              </View>
              <MaterialCommunityIcons
                color={colors.textMuted}
                name="unfold-more-horizontal"
                size={18}
              />
            </Pressable>

            <Pressable
              accessibilityRole="button"
              disabled={!connected || !hasControl || !project}
              onPress={onNewThread}
              style={[
                styles.drawerNewThread,
                (!connected || !hasControl || !project) && styles.disabled,
              ]}
            >
              <MaterialCommunityIcons color={colors.text} name="plus" size={20} />
              <Text style={styles.drawerNewThreadText}>New thread</Text>
            </Pressable>

            <ScrollView
              contentContainerStyle={styles.drawerScroll}
              showsVerticalScrollIndicator={false}
            >
              <View style={styles.drawerNavigation}>
                {DRAWER_DESTINATIONS.map((item) => {
                  const selected = activeDestination === item.id;
                  return (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      key={item.id}
                      onPress={() => onSelectDestination(item.id)}
                      style={[
                        styles.drawerNavItem,
                        selected && styles.drawerNavItemActive,
                      ]}
                    >
                      <MaterialCommunityIcons
                        color={selected ? colors.text : colors.textSecondary}
                        name={item.icon}
                        size={19}
                      />
                      <Text
                        style={[
                          styles.drawerNavText,
                          selected && styles.drawerNavTextActive,
                        ]}
                      >
                        {item.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>

              <View style={styles.drawerSectionHeader}>
                <Text style={styles.drawerSectionTitle}>Threads</Text>
                <Text style={styles.drawerSectionCount}>{sessions.length}</Text>
              </View>
              {sessions.length === 0 ? (
                <Text style={styles.drawerEmpty}>
                  Threads from this project will appear here.
                </Text>
              ) : (
                sessions.map((session) => {
                  const selected = session.id === activeSessionId;
                  return (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      key={session.id}
                      onPress={() => onSelectSession(session)}
                      style={[
                        styles.drawerThread,
                        selected && styles.drawerThreadActive,
                      ]}
                    >
                      <MaterialCommunityIcons
                        color={selected ? colors.primaryStrong : colors.textMuted}
                        name="message-text-outline"
                        size={17}
                      />
                      <View style={styles.grow}>
                        <Text numberOfLines={1} style={styles.drawerThreadTitle}>
                          {session.title}
                        </Text>
                        <Text numberOfLines={1} style={styles.drawerThreadMeta}>
                          {formatSessionMeta(session)}
                        </Text>
                      </View>
                    </Pressable>
                  );
                })
              )}
            </ScrollView>

            <ControlButton
              connected={connected}
              hasControl={hasControl}
              onRelease={onRelease}
              onTake={onTake}
            />
          </SafeAreaView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function WorkspaceView({
  canvases,
  destination,
  folderBusyId,
  hasControl,
  navigation,
  onOpen,
  onToggleFolder,
  pages,
  remoteStream,
  skills,
}: {
  canvases: WorkspaceItem[];
  destination: Exclude<BeziDestination, "threads">;
  folderBusyId: string | null;
  hasControl: boolean;
  navigation: WorkspaceItem[];
  onOpen: (item: WorkspaceItem) => void;
  onToggleFolder: (item: WorkspaceItem) => void;
  pages: WorkspaceItem[];
  remoteStream: ReturnType<typeof useRemoteStream>;
  skills: string[];
}) {
  if (destination === "remote") {
    return (
      <View style={styles.remoteView}>
        <View style={styles.workspaceIntroCompact}>
          <View style={styles.workspaceIcon}>
            <MaterialCommunityIcons
              color={colors.primaryStrong}
              name="monitor-share"
              size={22}
            />
          </View>
          <View style={styles.grow}>
            <Text style={styles.workspaceTitle}>Live Bezi window</Text>
            <Text style={styles.workspaceCopy}>
              Touch control for pages, canvases, and desktop-only workflows.
            </Text>
          </View>
        </View>
        <RemoteSurface
          controlEnabled={hasControl}
          onSignal={remoteStream.onSignal}
          signal={remoteStream.signal}
        />
      </View>
    );
  }

  const navigationTitle =
    destination === "plans" ? "Plans" : destination === "rules" ? "Your Rules" : null;
  const navigationItem = navigationTitle
    ? navigation.find((item) => item.title === navigationTitle)
    : undefined;
  const descriptor = workspaceDescriptor(destination);

  return (
    <View style={styles.workspace}>
      <View style={styles.workspaceIntro}>
        <View style={styles.workspaceIcon}>
          <MaterialCommunityIcons
            color={colors.primaryStrong}
            name={descriptor.icon}
            size={23}
          />
        </View>
        <Text style={styles.workspaceTitle}>{descriptor.title}</Text>
        <Text style={styles.workspaceCopy}>{descriptor.copy}</Text>
      </View>

      {destination === "pages" ? (
        <>
          <WorkspaceList
            empty="No pages are currently visible in this Bezi workspace."
            folderBusyId={folderBusyId}
            hasControl={hasControl}
            icon="file-document-outline"
            items={pages}
            label="Private & shared pages"
            meta="Document"
            onOpen={onOpen}
            onToggleFolder={onToggleFolder}
          />
          <WorkspaceList
            empty="No canvases are currently visible."
            icon="view-grid-outline"
            items={canvases}
            label="Canvases"
            meta="Canvas"
            onOpen={onOpen}
          />
        </>
      ) : destination === "skills" ? (
        <View style={styles.libraryList}>
          <Text style={styles.sectionLabel}>Installed in this workspace</Text>
          {skills.length === 0 ? (
            <EmptyCollection text="No local Bezi skills were found." />
          ) : (
            skills.map((skill) => (
              <View key={skill} style={styles.skillRow}>
                <View style={styles.workspaceItemIcon}>
                  <MaterialCommunityIcons
                    color={colors.primary}
                    name="puzzle-outline"
                    size={19}
                  />
                </View>
                <View style={styles.grow}>
                  <Text style={styles.workspaceItemTitle}>{skill}</Text>
                  <Text style={styles.workspaceItemMeta}>Bezi skill</Text>
                </View>
              </View>
            ))
          )}
        </View>
      ) : (
        <View style={styles.libraryList}>
          <Text style={styles.sectionLabel}>
            {destination === "plans" ? "Planning workspace" : "Workspace instructions"}
          </Text>
          {destination === "plans" ? (
            <View style={styles.planCallout}>
              <MaterialCommunityIcons
                color={colors.primaryStrong}
                name="lightbulb-on-outline"
                size={21}
              />
              <View style={styles.grow}>
                <Text style={styles.workspaceItemTitle}>
                  Create a plan with Plan Mode
                </Text>
                <Text style={styles.workspaceItemMeta}>
                  Plans are authored through a Bezi thread, just like on desktop.
                </Text>
              </View>
            </View>
          ) : null}
          {navigationItem ? (
            <Pressable
              accessibilityRole="button"
              disabled={!hasControl}
              onPress={() => onOpen(navigationItem)}
              style={[styles.documentRow, !hasControl && styles.disabled]}
            >
              <View style={styles.documentIcon}>
                <MaterialCommunityIcons
                  color={colors.primaryStrong}
                  name={
                    destination === "plans"
                      ? "format-list-checks"
                      : "book-cog-outline"
                  }
                  size={22}
                />
              </View>
              <View style={styles.grow}>
                <Text style={styles.documentTitle}>
                  {destination === "plans" ? "Open Plans" : "Open Your Rules"}
                </Text>
                <Text style={styles.documentMeta}>
                  Live from the Bezi desktop workspace
                </Text>
              </View>
              <MaterialCommunityIcons
                color={colors.textMuted}
                name="chevron-right"
                size={21}
              />
            </Pressable>
          ) : (
            <EmptyCollection
              text={`${descriptor.title} is not visible in the current Bezi window.`}
            />
          )}
        </View>
      )}

      <View style={styles.fullRemoteCallout}>
        <View style={styles.grow}>
          <Text style={styles.fullRemoteTitle}>Need the exact desktop view?</Text>
          <Text style={styles.fullRemoteCopy}>
            Full Remote preserves every Bezi workflow that is not yet native here.
          </Text>
        </View>
        <MaterialCommunityIcons
          color={colors.textMuted}
          name="monitor-share"
          size={22}
        />
      </View>
    </View>
  );
}

function WorkspaceList({
  empty,
  folderBusyId = null,
  hasControl = true,
  icon,
  items,
  label,
  meta,
  onOpen,
  onToggleFolder,
}: {
  empty: string;
  folderBusyId?: string | null;
  hasControl?: boolean;
  icon: keyof typeof MaterialCommunityIcons.glyphMap;
  items: WorkspaceItem[];
  label: string;
  meta: string;
  onOpen: (item: WorkspaceItem) => void;
  onToggleFolder?: (item: WorkspaceItem) => void;
}) {
  const itemCount = items.filter((item) => item.kind !== "folder").length;
  return (
    <View style={styles.libraryList}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionLabel}>{label}</Text>
        <Text style={styles.sectionCount}>{itemCount}</Text>
      </View>
      {items.length === 0 ? (
        <EmptyCollection text={empty} />
      ) : (
        items.map((item) => {
          const folder = item.kind === "folder";
          const busy = folderBusyId === item.id;
          const disabled =
            folder &&
            (!onToggleFolder || busy || (item.remote && !hasControl));
          const title = decodeHtml(item.title);
          return (
            <Pressable
              accessibilityLabel={
                folder
                  ? `${item.expanded ? "Collapse" : "Expand"} ${title} folder`
                  : `Open ${title}`
              }
              accessibilityRole="button"
              accessibilityState={{
                busy,
                disabled,
                expanded: folder ? item.expanded : undefined,
              }}
              disabled={disabled}
              key={item.id}
              onPress={() =>
                folder ? onToggleFolder?.(item) : onOpen(item)
              }
              style={[
                styles.documentRow,
                folder && styles.folderRow,
                item.depth > 0 && {
                  marginLeft: Math.min(item.depth, 5) * 18,
                },
                disabled && styles.disabled,
              ]}
            >
              <View
                style={[
                  styles.documentIcon,
                  folder && styles.folderIcon,
                ]}
              >
                <MaterialCommunityIcons
                  color={colors.primaryStrong}
                  name={
                    folder
                      ? item.expanded
                        ? "folder-open-outline"
                        : "folder-outline"
                      : icon
                  }
                  size={22}
                />
              </View>
              <View style={styles.grow}>
                <Text numberOfLines={2} style={styles.documentTitle}>
                  {title}
                </Text>
                <Text style={styles.documentMeta}>
                  {folder
                    ? item.expanded
                      ? "Folder · Open"
                      : "Folder"
                    : meta}
                </Text>
              </View>
              {busy ? (
                <ActivityIndicator color={colors.primaryStrong} size="small" />
              ) : (
                <MaterialCommunityIcons
                  color={colors.textMuted}
                  name={
                    folder
                      ? item.expanded
                        ? "chevron-down"
                        : "chevron-right"
                      : "chevron-right"
                  }
                  size={21}
                />
              )}
            </Pressable>
          );
        })
      )}
    </View>
  );
}

function EmptyCollection({ text }: { text: string }) {
  return (
    <View style={styles.emptyCollection}>
      <Text style={styles.emptyCollectionText}>{text}</Text>
    </View>
  );
}

function ControlStrip({
  connected,
  hasControl,
  onRelease,
  onTake,
}: {
  connected: boolean;
  hasControl: boolean;
  onRelease: () => void;
  onTake: () => void;
}) {
  if (connected && hasControl) {
    return (
      <Pressable
        accessibilityLabel="Control active. Tap to release."
        accessibilityRole="button"
        onPress={onRelease}
        style={styles.controlStrip}
      >
        <View style={[styles.liveDot, { backgroundColor: colors.live }]} />
        <Text style={styles.controlStripText}>Control active</Text>
        <Text style={styles.controlStripAction}>Release</Text>
      </Pressable>
    );
  }
  return (
    <Pressable
      accessibilityLabel={
        connected ? "Hold to take control" : "Windows companion offline"
      }
      accessibilityRole="button"
      delayLongPress={650}
      disabled={!connected}
      onLongPress={() => {
        onTake();
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
      }}
      style={[styles.controlStrip, !connected && styles.disabled]}
    >
      <MaterialCommunityIcons
        color={connected ? colors.primary : colors.textMuted}
        name={connected ? "gesture-tap-hold" : "cloud-off-outline"}
        size={15}
      />
      <Text style={styles.controlStripText}>
        {connected ? "Hold to take control" : "Companion offline"}
      </Text>
    </Pressable>
  );
}

function ControlButton({
  connected,
  hasControl,
  onRelease,
  onTake,
}: {
  connected: boolean;
  hasControl: boolean;
  onRelease: () => void;
  onTake: () => void;
}) {
  return (
    <Pressable
      accessibilityLabel={hasControl ? "Release control" : "Hold to take control"}
      accessibilityRole="button"
      delayLongPress={650}
      disabled={!connected}
      onLongPress={() => {
        onTake();
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
      }}
      onPress={hasControl ? onRelease : undefined}
      style={[
        styles.controlButton,
        hasControl && styles.controlButtonActive,
        !connected && styles.disabled,
      ]}
    >
      <MaterialCommunityIcons
        color={hasControl ? colors.primaryInk : colors.primary}
        name={hasControl ? "shield-check" : "gesture-tap-hold"}
        size={19}
      />
      <View style={styles.grow}>
        <Text
          style={[
            styles.controlButtonTitle,
            hasControl && styles.controlButtonTitleActive,
          ]}
        >
          {hasControl ? "Control active" : "Hold to take control"}
        </Text>
        <Text
          style={[
            styles.controlButtonMeta,
            hasControl && styles.controlButtonMetaActive,
          ]}
        >
          {hasControl ? "Tap to release" : "One phone can control at a time"}
        </Text>
      </View>
    </Pressable>
  );
}

function MessageCard({
  entry,
  onOpenDiff,
}: {
  entry: ChatEntry;
  onOpenDiff: (file: BeziDiffFile) => void;
}) {
  const [expanded, setExpanded] = useState(entry.activityKind !== "thought");
  if (entry.role === "activity") {
    const isThought = entry.activityKind === "thought";
    const isCode = entry.activityKind === "code" || Boolean(entry.files?.length);
    if (isThought) {
      return (
        <Pressable
          accessibilityLabel={`${expanded ? "Collapse" : "Expand"} Bezi thoughts`}
          accessibilityRole="button"
          onPress={() => setExpanded((value) => !value)}
          style={styles.thoughtCard}
        >
          <View style={styles.thoughtHeader}>
            <MaterialCommunityIcons
              color={colors.textMuted}
              name="lightbulb-on-outline"
              size={16}
            />
            <Text style={styles.thoughtState}>Explored</Text>
            <Text style={styles.thoughtLabel}>Thoughts</Text>
            <View style={styles.grow} />
            <MaterialCommunityIcons
              color={colors.textMuted}
              name={expanded ? "chevron-up" : "chevron-down"}
              size={18}
            />
          </View>
          {expanded && entry.detail ? (
            <View style={styles.thoughtDetail}>
              <BeziMarkdown compact secondary>
                {entry.detail}
              </BeziMarkdown>
            </View>
          ) : null}
        </Pressable>
      );
    }

    return (
      <View style={[styles.activityCard, isCode && styles.codeActivityCard]}>
        <Pressable
          accessibilityLabel={`${expanded ? "Collapse" : "Expand"} ${entry.text}`}
          accessibilityRole="button"
          onPress={() => setExpanded((value) => !value)}
          style={styles.activityHeader}
        >
          <View style={styles.activityIcon}>
            <MaterialCommunityIcons
              color={isCode ? colors.live : colors.selection}
              name={activityIcon(entry.toolKind ?? entry.text)}
              size={17}
            />
          </View>
          <View style={styles.grow}>
            <Text numberOfLines={2} style={styles.activityTitle}>
              {cleanActivityTitle(entry.text)}
            </Text>
            <View style={styles.activityMetaRow}>
              {entry.files?.length ? (
                <Text style={styles.activityChangeCount}>
                  {entry.files.reduce((sum, file) => sum + file.additions, 0) > 0
                    ? `+${entry.files.reduce(
                        (sum, file) => sum + file.additions,
                        0,
                      )}`
                    : ""}
                  {entry.files.reduce((sum, file) => sum + file.deletions, 0) > 0
                    ? `  -${entry.files.reduce(
                        (sum, file) => sum + file.deletions,
                        0,
                      )}`
                    : ""}
                </Text>
              ) : null}
              {entry.status ? (
                <Text
                  style={[
                    styles.activityStatus,
                    statusTone(entry.status) === "danger" &&
                      styles.activityStatusDanger,
                  ]}
                >
                  {formatActivityStatus(entry.status)}
                </Text>
              ) : null}
            </View>
          </View>
          <MaterialCommunityIcons
            color={colors.textMuted}
            name={expanded ? "chevron-up" : "chevron-down"}
            size={18}
          />
        </Pressable>

        {expanded ? (
          <View style={styles.activityBody}>
            {entry.detail ? (
              <View style={styles.activityDetail}>
                <BeziMarkdown compact secondary>
                  {entry.detail}
                </BeziMarkdown>
              </View>
            ) : null}
            {entry.files?.map((file) => (
              <DiffPreviewCard file={file} key={file.path} onOpen={onOpenDiff} />
            ))}
          </View>
        ) : null}
      </View>
    );
  }
  if (entry.role === "user") {
    return (
      <View style={styles.userMessage}>
        <BeziMarkdown>
          {entry.text}
        </BeziMarkdown>
      </View>
    );
  }
  return (
    <View style={styles.assistantMessage}>
      <View style={styles.assistantMark}>
        <Text style={styles.assistantMarkText}>B</Text>
      </View>
      <View style={styles.assistantMessageBody}>
        <BeziMarkdown>{entry.text}</BeziMarkdown>
      </View>
    </View>
  );
}

function DiffPreviewCard({
  file,
  onOpen,
}: {
  file: BeziDiffFile;
  onOpen: (file: BeziDiffFile) => void;
}) {
  const preview = previewDiffLines(file);
  return (
    <Pressable
      accessibilityLabel={`Open full diff for ${displayFilePath(file.path)}`}
      accessibilityRole="button"
      onPress={() => onOpen(file)}
      style={styles.diffPreview}
    >
      <View style={styles.diffPreviewHeader}>
        <MaterialCommunityIcons
          color={colors.textSecondary}
          name="code-tags"
          size={17}
        />
        <Text numberOfLines={1} style={styles.diffPreviewPath}>
          {displayFilePath(file.path)}
        </Text>
        <Text style={styles.diffAdditions}>+{file.additions}</Text>
        <Text style={styles.diffDeletions}>-{file.deletions}</Text>
        <MaterialCommunityIcons
          color={colors.textMuted}
          name="open-in-new"
          size={15}
        />
      </View>
      <View style={styles.diffCodePreview}>
        {preview.map((line, index) => (
          <View
            key={`${line.number}-${index}`}
            style={[
              styles.diffPreviewLine,
              line.kind === "added" && styles.diffLineAdded,
              line.kind === "removed" && styles.diffLineRemoved,
            ]}
          >
            <Text style={styles.diffPreviewNumber}>{line.number}</Text>
            <Text
              numberOfLines={1}
              style={[
                styles.diffPreviewCode,
                line.kind === "added" && styles.diffCodeAdded,
                line.kind === "removed" && styles.diffCodeRemoved,
              ]}
            >
              {line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " "}
              {line.text || " "}
            </Text>
          </View>
        ))}
      </View>
      <View style={styles.diffOpenRow}>
        <Text style={styles.diffOpenText}>View full script and diff</Text>
        <MaterialCommunityIcons
          color={colors.primaryStrong}
          name="chevron-right"
          size={17}
        />
      </View>
    </Pressable>
  );
}

function DiffViewer({
  file,
  onClose,
}: {
  file: BeziDiffFile | null;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<"diff" | "updated">("diff");
  useEffect(() => {
    if (file) setMode("diff");
  }, [file]);
  const rows = useMemo(() => {
    if (!file) return [];
    if (mode === "diff") return buildBeziLineDiff(file);
    return file.newText.replace(/\r\n/g, "\n").split("\n").map((text, index) => ({
      kind: "context" as const,
      text,
      oldNumber: undefined,
      newNumber: index + 1,
    }));
  }, [file, mode]);
  return (
    <Modal animationType="slide" onRequestClose={onClose} visible={file !== null}>
      <SafeAreaView edges={["top", "bottom"]} style={styles.diffViewer}>
        <View style={styles.diffViewerHeader}>
          <Pressable
            accessibilityLabel="Close code diff"
            accessibilityRole="button"
            onPress={onClose}
            style={styles.diffViewerClose}
          >
            <MaterialCommunityIcons color={colors.text} name="close" size={23} />
          </Pressable>
          <View style={styles.diffViewerIdentity}>
            <Text numberOfLines={1} style={styles.diffViewerTitle}>
              {file ? fileName(file.path) : "Code diff"}
            </Text>
            <Text numberOfLines={1} style={styles.diffViewerPath}>
              {file ? displayFilePath(file.path) : ""}
            </Text>
          </View>
          {file ? (
            <View style={styles.diffViewerStats}>
              <Text style={styles.diffAdditions}>+{file.additions}</Text>
              <Text style={styles.diffDeletions}>-{file.deletions}</Text>
            </View>
          ) : null}
        </View>
        <View style={styles.diffTabs}>
          {(["diff", "updated"] as const).map((value) => {
            const selected = mode === value;
            return (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected }}
                key={value}
                onPress={() => setMode(value)}
                style={[styles.diffTab, selected && styles.diffTabActive]}
              >
                <Text
                  style={[
                    styles.diffTabText,
                    selected && styles.diffTabTextActive,
                  ]}
                >
                  {value === "diff" ? "Changes" : "Updated script"}
                </Text>
              </Pressable>
            );
          })}
        </View>
        <ScrollView
          contentContainerStyle={styles.diffViewerBody}
          showsVerticalScrollIndicator
        >
          {rows.map((line, index) => (
            <View
              key={`${line.kind}-${line.oldNumber ?? "x"}-${
                line.newNumber ?? "x"
              }-${index}`}
              style={[
                styles.diffViewerLine,
                line.kind === "added" && styles.diffLineAdded,
                line.kind === "removed" && styles.diffLineRemoved,
              ]}
            >
              <Text style={styles.diffViewerLineNumber}>
                {line.oldNumber ?? " "}
              </Text>
              <Text style={styles.diffViewerLineNumber}>
                {line.newNumber ?? " "}
              </Text>
              <Text
                selectable
                style={[
                  styles.diffViewerCode,
                  line.kind === "added" && styles.diffCodeAdded,
                  line.kind === "removed" && styles.diffCodeRemoved,
                ]}
              >
                {line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " "}
                {line.text || " "}
              </Text>
            </View>
          ))}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

function EmptyState({
  icon,
  title,
  copy,
}: {
  icon: keyof typeof MaterialCommunityIcons.glyphMap;
  title: string;
  copy: string;
}) {
  return (
    <View style={styles.emptyState}>
      <View style={styles.emptyIcon}>
        <MaterialCommunityIcons color={colors.primary} name={icon} size={25} />
      </View>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyCopy}>{copy}</Text>
    </View>
  );
}

function BottomSheet({
  open,
  onClose,
  title,
  children,
}: PropsWithChildren<{
  open: boolean;
  onClose: () => void;
  title: string;
}>) {
  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
      transparent
      visible={open}
    >
      <Pressable onPress={onClose} style={styles.sheetBackdrop}>
        <Pressable onPress={() => undefined} style={styles.sheet}>
          <View style={styles.sheetHandle} />
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>{title}</Text>
            <Pressable
              accessibilityLabel="Close"
              accessibilityRole="button"
              onPress={onClose}
              style={styles.sheetClose}
            >
              <MaterialCommunityIcons
                color={colors.textSecondary}
                name="close"
                size={21}
              />
            </Pressable>
          </View>
          <ScrollView
            contentContainerStyle={styles.sheetBody}
            showsVerticalScrollIndicator={false}
          >
            {children}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function openSession(
  session: BeziSession,
  send: ReturnType<typeof useSession>["send"],
  request: MutableRefObject<string | null>,
  pendingSession: MutableRefObject<string | null>,
  buffer: MutableRefObject<ChatEntry[] | null>,
  clearOnEmpty: MutableRefObject<boolean>,
  setBusy: Dispatch<SetStateAction<boolean>>,
  shouldClearOnEmpty: boolean,
  showBusy: boolean,
) {
  if (showBusy) setBusy(true);
  pendingSession.current = session.id;
  buffer.current = [];
  clearOnEmpty.current = shouldClearOnEmpty;
  const requestId = send(
    "bezi.session.load",
    {
      sessionId: session.id,
      cwd: session.cwd,
      mcpServers: [],
    },
    { kind: "signaling" },
  );
  request.current = requestId;
  if (!requestId) {
    pendingSession.current = null;
    buffer.current = null;
    clearOnEmpty.current = false;
    if (showBusy) setBusy(false);
  }
  return requestId;
}

function parseWorkspace(
  body: Record<string, unknown> | undefined,
  catalog: Record<string, unknown> | null,
) {
  const workspace = catalog ?? asRecord(body?.beziWorkspace);
  const projects = parseWorkspaceProjects(workspace?.projects);
  const skills = Array.isArray(workspace?.skills)
    ? workspace.skills.filter((value): value is string => typeof value === "string")
    : [];
  const activeWorkspaceId = stringValue(workspace?.activeWorkspaceId);
  const groups = Array.isArray(workspace?.workspaces)
    ? workspace.workspaces
        .map(asRecord)
        .filter((value): value is Record<string, unknown> => value !== null)
        .flatMap((value): BeziWorkspace[] => {
          const id = stringValue(value.id);
          if (!id) return [];
          const ui = asRecord(value.ui);
          return [
            {
              id,
              label: stringValue(value.label) ?? `Workspace ${id.slice(0, 8)}`,
              projects: parseWorkspaceProjects(value.projects),
              activeProjectId: stringValue(value.activeProjectId),
              isActive:
                value.isActive === true || (activeWorkspaceId !== null && id === activeWorkspaceId),
              pages: parseWorkspaceItems(ui?.pages),
              canvases: parseWorkspaceItems(ui?.canvases),
              navigation: parseWorkspaceItems(ui?.navigation),
            },
          ];
        })
    : [];
  const ui = asRecord(workspace?.ui);
  const fallbackWorkspace: BeziWorkspace = {
    id: activeWorkspaceId ?? "local-bezi-workspace",
    label: projects[0]?.label ?? "Bezi workspace",
    projects,
    activeProjectId: stringValue(workspace?.activeProjectId),
    isActive: true,
    pages: parseWorkspaceItems(ui?.pages),
    canvases: parseWorkspaceItems(ui?.canvases),
    navigation: parseWorkspaceItems(ui?.navigation),
  };
  const workspaces = groups.length > 0 ? groups : projects.length > 0 ? [fallbackWorkspace] : [];
  return {
    workspaces,
    skills,
    activeWorkspaceId:
      activeWorkspaceId ??
      workspaces.find((value) => value.isActive)?.id ??
      workspaces[0]?.id ??
      null,
  };
}

function parseWorkspaceProjects(value: unknown): WorkspaceProject[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(asRecord)
    .filter((project): project is Record<string, unknown> => project !== null)
    .flatMap((project): WorkspaceProject[] => {
      const id = stringValue(project.id);
      const label = stringValue(project.label);
      const path = stringValue(project.path);
      if (!id || !label || !path) return [];
      return [
        {
          id,
          label,
          path,
          lastModified: stringValue(project.lastModified),
        },
      ];
    });
}

function applyAdvertisedChoices(
  result: Record<string, unknown> | null,
  setChoices: Dispatch<
    SetStateAction<{
      modes: AdvertisedChoice[];
      models: AdvertisedChoice[];
      mode?: string;
      model?: string;
    }>
  >,
) {
  if (!result) return;
  const modes = parseChoices(result.modes ?? result.availableModes);
  const models = parseChoices(result.models ?? result.availableModels);
  setChoices({
    modes,
    models,
    mode:
      stringValue(result.currentModeId) ??
      stringValue(result.modeId) ??
      modes[0]?.id,
    model:
      stringValue(result.currentModelId) ??
      stringValue(result.modelId) ??
      models[0]?.id,
  });
}

function parseChoices(value: unknown): AdvertisedChoice[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (typeof entry === "string") return { id: entry, name: entry };
      const record = asRecord(entry);
      const id = stringValue(record?.id) ?? stringValue(record?.value);
      if (!id) return null;
      return {
        id,
        name: stringValue(record?.name) ?? stringValue(record?.label) ?? id,
      };
    })
    .filter((entry): entry is AdvertisedChoice => entry !== null);
}

function workspaceDescriptor(destination: Exclude<BeziDestination, "threads" | "remote">) {
  if (destination === "pages") {
    return {
      title: "Pages",
      copy: "Long-form documents created by you and Bezi, organized for reading on mobile.",
      icon: "file-document-outline" as const,
    };
  }
  if (destination === "plans") {
    return {
      title: "Plans",
      copy: "Shape implementation before work begins, then return to the thread to execute.",
      icon: "format-list-checks" as const,
    };
  }
  if (destination === "rules") {
    return {
      title: "Your Rules",
      copy: "The standing instructions that guide how Bezi works in this workspace.",
      icon: "book-cog-outline" as const,
    };
  }
  return {
    title: "Skills",
    copy: "Reusable capabilities installed in the live Bezi workspace.",
    icon: "puzzle-outline" as const,
  };
}

function destinationLabel(destination: BeziDestination) {
  return DRAWER_DESTINATIONS.find((item) => item.id === destination)?.label ?? "Bezi";
}

function choiceDisplayName(
  choices: AdvertisedChoice[],
  selectedId: string | undefined,
  fallback: string,
) {
  return choices.find((choice) => choice.id === selectedId)?.name ?? selectedId ?? fallback;
}

function formatSessionMeta(session: BeziSession) {
  if (!session.updatedAt) return "Bezi thread";
  const date = new Date(session.updatedAt);
  if (Number.isNaN(date.getTime())) return "Bezi thread";
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return `Today · ${date.toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    })}`;
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function cleanActivityTitle(value: string) {
  if (value.startsWith("Edit ")) return displayFilePath(value.slice(5));
  return value;
}

function displayFilePath(value: string) {
  const normalized = value.replaceAll("\\", "/");
  const assetsIndex = normalized.toLowerCase().indexOf("/assets/");
  if (assetsIndex >= 0) {
    const prefix = normalized.slice(0, assetsIndex);
    const project = prefix.split("/").filter(Boolean).at(-1);
    return `/${project ?? "Project"}${normalized.slice(assetsIndex)}`;
  }
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function fileName(value: string) {
  return value.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) ?? value;
}

function formatActivityStatus(value: string) {
  const readable = value.replaceAll("_", " ");
  return readable.charAt(0).toUpperCase() + readable.slice(1);
}

function statusTone(value: string) {
  const normalized = value.toLowerCase();
  return normalized.includes("fail") || normalized.includes("error")
    ? "danger"
    : "default";
}

function previewDiffLines(file: BeziDiffFile) {
  const oldLines = file.oldText.replace(/\r\n/g, "\n").split("\n");
  const newLines = file.newText.replace(/\r\n/g, "\n").split("\n");
  let firstChange = 0;
  while (
    firstChange < oldLines.length &&
    firstChange < newLines.length &&
    oldLines[firstChange] === newLines[firstChange]
  ) {
    firstChange += 1;
  }
  const source = newLines.length > 0 ? newLines : oldLines;
  const start = Math.max(0, firstChange - 2);
  const end = Math.min(source.length, start + 7);
  return source.slice(start, end).map((text, offset) => {
    const index = start + offset;
    const changed = oldLines[index] !== newLines[index];
    return {
      number: index + 1,
      text,
      kind: changed
        ? newLines.length > 0
          ? ("added" as const)
          : ("removed" as const)
        : ("context" as const),
    };
  });
}

function activityIcon(text: string): keyof typeof MaterialCommunityIcons.glyphMap {
  const value = text.toLowerCase();
  if (value.includes("diff") || value.includes("edit")) {
    return "file-document-edit-outline";
  }
  if (value.includes("plan")) return "format-list-checks";
  if (value.includes("command")) return "console";
  if (value.includes("search")) return "magnify";
  if (value.includes("read")) return "file-search-outline";
  if (value.includes("think")) return "lightbulb-on-outline";
  return "progress-wrench";
}

function launchStatus(state: BeziLaunchState) {
  const slowCopy =
    "This is taking longer than usual. Keep the Bezi desktop app open while we finish connecting.";
  if (state.phase === "connecting") {
    return {
      title: state.resumePhase ? "Reconnecting to Bezi" : "Connecting to Bezi",
      copy: state.slow
        ? slowCopy
        : "Preparing a secure connection to your desktop.",
    };
  }
  if (state.phase === "loading-workspaces") {
    return {
      title: "Loading workspaces",
      copy: state.slow
        ? slowCopy
        : "Finding the workspaces available from your Bezi desktop app.",
    };
  }
  if (state.phase === "loading-threads") {
    return {
      title: "Loading your latest thread",
      copy: state.slow
        ? slowCopy
        : "Looking for the newest conversation in this project.",
    };
  }
  return {
    title: "Opening newest thread",
    copy: state.slow
      ? slowCopy
      : "Syncing its messages, plans, tools, and recent activity.",
  };
}

function compactPath(value: string) {
  const normalized = value.replaceAll("\\", "/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 3) return value;
  return `…/${parts.slice(-3).join("/")}`;
}

function decodeHtml(value: string) {
  return value.replaceAll("&amp;", "&");
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.backgroundDeep },
  safe: { flex: 1, backgroundColor: colors.background },
  grow: { flex: 1 },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  disabled: { opacity: 0.4 },
  launchSafe: {
    flex: 1,
    backgroundColor: colors.background,
  },
  launchBrandRow: {
    minHeight: 64,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.xl,
  },
  launchBrandMark: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#4A4554",
    backgroundColor: "#29262E",
  },
  launchBrand: {
    ...typography.heading,
    color: colors.text,
    letterSpacing: -0.2,
  },
  launchAnimated: {
    flex: 1,
  },
  launchChoiceHeader: {
    minHeight: 70,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.xl,
  },
  launchBack: {
    position: "absolute",
    left: spacing.lg,
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    paddingHorizontal: spacing.xs,
    borderRadius: radius.md,
  },
  launchBackPlaceholder: {
    position: "absolute",
    left: spacing.lg,
    width: 70,
  },
  launchBackText: {
    ...typography.label,
    color: colors.textSecondary,
  },
  launchSteps: {
    flexDirection: "row",
    alignItems: "center",
  },
  launchStep: {
    alignItems: "center",
    gap: 6,
  },
  launchStepDot: {
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  launchStepDotActive: {
    borderColor: colors.primaryStrong,
    backgroundColor: colors.primaryStrong,
  },
  launchStepNumber: {
    ...typography.caption,
    color: colors.primaryInk,
    fontSize: 11,
    lineHeight: 14,
  },
  launchStepNumberMuted: {
    color: colors.textMuted,
  },
  launchStepText: {
    ...typography.caption,
    color: colors.textMuted,
  },
  launchStepTextActive: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  launchStepLine: {
    width: 44,
    height: 1,
    marginHorizontal: spacing.sm,
    marginBottom: 22,
    backgroundColor: colors.border,
  },
  launchStepLineActive: {
    backgroundColor: colors.primary,
  },
  launchHeading: {
    gap: spacing.sm,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xl,
  },
  launchTitle: {
    ...typography.title,
    color: colors.text,
    textAlign: "center",
    letterSpacing: -0.5,
  },
  launchCopy: {
    ...typography.body,
    maxWidth: 420,
    alignSelf: "center",
    color: colors.textSecondary,
    textAlign: "center",
  },
  launchChoices: {
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xxxl,
  },
  launchChoice: {
    minHeight: 82,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSoft,
    backgroundColor: colors.surface,
  },
  launchChoiceSelected: {
    borderColor: "#625B79",
    backgroundColor: "#2B2832",
  },
  launchChoicePressed: {
    opacity: 0.72,
  },
  launchChoiceIcon: {
    width: 48,
    height: 48,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#4A4554",
    backgroundColor: "#29262E",
  },
  launchChoiceTitle: {
    ...typography.heading,
    color: colors.text,
    fontSize: 17,
    lineHeight: 22,
  },
  launchChoiceMeta: {
    ...typography.caption,
    color: colors.textMuted,
    marginTop: 3,
  },
  launchEmpty: {
    minHeight: 180,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    padding: spacing.xl,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSoft,
    backgroundColor: colors.surface,
  },
  launchEmptyTitle: {
    ...typography.heading,
    color: colors.text,
    marginTop: spacing.xs,
  },
  launchEmptyCopy: {
    ...typography.body,
    maxWidth: 300,
    color: colors.textMuted,
    textAlign: "center",
  },
  launchStatus: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.xxl,
    paddingBottom: 84,
  },
  launchStatusIcon: {
    width: 72,
    height: 72,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.sm,
    borderRadius: 24,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#4A4554",
    backgroundColor: "#29262E",
  },
  launchErrorIcon: {
    borderColor: "#643D3D",
    backgroundColor: "#332526",
  },
  launchProgressTrack: {
    width: 124,
    height: 3,
    overflow: "hidden",
    marginTop: spacing.lg,
    borderRadius: 2,
    backgroundColor: colors.surfaceStrong,
  },
  launchProgressFill: {
    width: "58%",
    height: "100%",
    borderRadius: 2,
    backgroundColor: colors.primaryStrong,
  },
  launchRetry: {
    minWidth: 160,
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    marginTop: spacing.lg,
    paddingHorizontal: spacing.xl,
    borderRadius: radius.md,
    backgroundColor: colors.primaryStrong,
  },
  launchRetryText: {
    ...typography.label,
    color: colors.primaryInk,
    fontSize: 15,
    lineHeight: 20,
  },
  topBar: {
    height: 64,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSoft,
    backgroundColor: "#232221",
  },
  topBarButton: {
    width: 48,
    height: 48,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.md,
  },
  topBarIdentity: {
    flex: 1,
    minWidth: 0,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.sm,
  },
  projectLine: {
    maxWidth: "100%",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
  },
  liveDot: { width: 7, height: 7, borderRadius: 4 },
  projectLineText: {
    ...typography.caption,
    color: colors.textMuted,
    maxWidth: "82%",
  },
  topBarTitle: {
    ...typography.label,
    color: colors.text,
    fontSize: 15,
    lineHeight: 20,
    marginTop: 1,
  },
  controlStrip: {
    minHeight: 34,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSoft,
    backgroundColor: colors.background,
  },
  controlStripText: { ...typography.caption, color: colors.textSecondary },
  controlStripAction: {
    ...typography.caption,
    color: colors.primaryStrong,
    marginLeft: spacing.xs,
  },
  threadScreen: { flex: 1 },
  timelineScroll: { flex: 1 },
  timeline: {
    flexGrow: 1,
    gap: spacing.xl,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xl,
    paddingBottom: spacing.xl,
  },
  agentStatus: {
    minHeight: 58,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#4A4554",
    backgroundColor: "#29262E",
  },
  agentStatusIndicator: {
    width: 30,
    height: 30,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.sm,
    backgroundColor: "#363141",
  },
  agentStatusLabel: {
    ...typography.label,
    color: colors.text,
  },
  agentStatusDetail: {
    ...typography.caption,
    color: colors.textMuted,
    marginTop: 1,
  },
  agentStatusLive: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 7,
    paddingVertical: 4,
    borderRadius: radius.pill,
    backgroundColor: "#20372B",
  },
  agentStatusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.live,
  },
  agentStatusLiveText: {
    fontSize: 9,
    lineHeight: 11,
    fontWeight: "800",
    letterSpacing: 0.7,
    color: colors.live,
  },
  inlineError: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: colors.codeRemove,
  },
  errorText: { ...typography.caption, color: "#FFD0CC", flex: 1 },
  emptyState: {
    flex: 1,
    minHeight: 330,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.xl,
  },
  emptyIcon: {
    width: 54,
    height: 54,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 18,
    backgroundColor: "#302D35",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#484252",
    marginBottom: spacing.xs,
  },
  emptyTitle: {
    ...typography.heading,
    color: colors.text,
    textAlign: "center",
  },
  emptyCopy: {
    ...typography.body,
    color: colors.textMuted,
    textAlign: "center",
    maxWidth: 310,
  },
  assistantMessage: {
    maxWidth: "100%",
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.md,
  },
  assistantMark: {
    width: 26,
    height: 26,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
    backgroundColor: colors.primary,
    marginTop: 1,
  },
  assistantMarkText: {
    color: colors.primaryInk,
    fontSize: 13,
    lineHeight: 16,
    fontWeight: "800",
  },
  assistantMessageBody: {
    minWidth: 0,
    flex: 1,
  },
  userMessage: {
    maxWidth: "88%",
    alignSelf: "flex-end",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: 18,
    borderBottomRightRadius: 6,
    backgroundColor: colors.surfaceStrong,
  },
  activityCard: {
    minHeight: 56,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSoft,
    backgroundColor: colors.surface,
    overflow: "hidden",
  },
  codeActivityCard: {
    borderColor: "#41403E",
    backgroundColor: "#22211F",
  },
  activityHeader: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.md,
  },
  activityIcon: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 9,
    backgroundColor: "#28344F",
  },
  activityTitle: {
    ...typography.label,
    color: colors.text,
  },
  activityMetaRow: {
    minHeight: 17,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginTop: 2,
  },
  activityChangeCount: {
    ...typography.caption,
    color: colors.live,
    fontFamily: "Courier",
  },
  activityStatus: {
    ...typography.caption,
    color: colors.textMuted,
    fontStyle: "italic",
  },
  activityStatusDanger: { color: colors.danger },
  activityBody: {
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingBottom: spacing.sm,
  },
  activityDetail: {
    paddingHorizontal: spacing.xs,
    paddingBottom: spacing.xs,
  },
  thoughtCard: {
    minHeight: 44,
    paddingHorizontal: spacing.xs,
    paddingVertical: spacing.xs,
    borderRadius: radius.sm,
  },
  thoughtHeader: {
    minHeight: 36,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
  },
  thoughtState: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  thoughtLabel: {
    ...typography.caption,
    color: colors.textMuted,
  },
  thoughtDetail: {
    paddingHorizontal: spacing.sm,
    paddingBottom: spacing.md,
  },
  diffPreview: {
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#45423F",
    backgroundColor: "#1A1918",
    overflow: "hidden",
  },
  diffPreviewHeader: {
    minHeight: 42,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#3A3836",
    backgroundColor: "#302E2C",
  },
  diffPreviewPath: {
    ...typography.mono,
    color: colors.textSecondary,
    flex: 1,
    fontSize: 11,
  },
  diffAdditions: {
    ...typography.mono,
    color: colors.live,
    fontWeight: "700",
  },
  diffDeletions: {
    ...typography.mono,
    color: colors.danger,
    fontWeight: "700",
  },
  diffCodePreview: {
    paddingVertical: spacing.xs,
  },
  diffPreviewLine: {
    minHeight: 20,
    flexDirection: "row",
    alignItems: "flex-start",
    paddingRight: spacing.sm,
  },
  diffPreviewNumber: {
    ...typography.mono,
    width: 38,
    color: colors.textMuted,
    textAlign: "right",
    paddingRight: spacing.sm,
    fontSize: 10,
    lineHeight: 20,
  },
  diffPreviewCode: {
    ...typography.mono,
    color: colors.textSecondary,
    flex: 1,
    fontSize: 10.5,
    lineHeight: 20,
  },
  diffLineAdded: { backgroundColor: "rgba(35, 86, 59, 0.62)" },
  diffLineRemoved: { backgroundColor: "rgba(90, 45, 49, 0.62)" },
  diffCodeAdded: { color: "#B7F4CB" },
  diffCodeRemoved: { color: "#FFD0D0" },
  diffOpenRow: {
    minHeight: 38,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#343230",
  },
  diffOpenText: {
    ...typography.caption,
    color: colors.primaryStrong,
  },
  diffViewer: {
    flex: 1,
    backgroundColor: colors.backgroundDeep,
  },
  diffViewerHeader: {
    minHeight: 68,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    backgroundColor: "#232221",
  },
  diffViewerClose: {
    width: 46,
    height: 46,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.md,
  },
  diffViewerIdentity: { flex: 1, minWidth: 0 },
  diffViewerTitle: {
    ...typography.label,
    color: colors.text,
    fontSize: 14,
  },
  diffViewerPath: {
    ...typography.mono,
    color: colors.textMuted,
    fontSize: 10,
    lineHeight: 14,
    marginTop: 2,
  },
  diffViewerStats: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingRight: spacing.sm,
  },
  diffTabs: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "flex-end",
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSoft,
    backgroundColor: colors.background,
  },
  diffTab: {
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: spacing.md,
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
  },
  diffTabActive: { borderBottomColor: colors.primaryStrong },
  diffTabText: { ...typography.label, color: colors.textMuted },
  diffTabTextActive: { color: colors.text },
  diffViewerBody: {
    minWidth: "100%",
    paddingVertical: spacing.sm,
    paddingBottom: spacing.xxxl,
  },
  diffViewerLine: {
    minHeight: 22,
    flexDirection: "row",
    alignItems: "flex-start",
    paddingRight: spacing.sm,
  },
  diffViewerLineNumber: {
    ...typography.mono,
    width: 34,
    color: colors.textMuted,
    textAlign: "right",
    paddingRight: 7,
    fontSize: 10,
    lineHeight: 22,
    backgroundColor: "rgba(255,255,255,0.025)",
  },
  diffViewerCode: {
    ...typography.mono,
    color: "#D7D3CE",
    flex: 1,
    minWidth: 0,
    fontSize: 11,
    lineHeight: 22,
  },
  permissionCard: { gap: spacing.md },
  permissionIcon: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 12,
    backgroundColor: "#40372A",
  },
  permissionActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  cardTitle: { ...typography.label, color: colors.text },
  cardMeta: { ...typography.caption, color: colors.textMuted },
  composerDock: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: Platform.OS === "ios" ? 96 : 78,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSoft,
    backgroundColor: colors.background,
  },
  composer: {
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
    overflow: "hidden",
  },
  composerInput: {
    minHeight: 48,
    maxHeight: 150,
    paddingHorizontal: spacing.lg,
    paddingTop: 14,
    paddingBottom: spacing.sm,
    ...typography.body,
    color: colors.text,
    textAlignVertical: "top",
  },
  composerFooter: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingBottom: spacing.sm,
  },
  composerRoundButton: {
    width: 38,
    height: 38,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceStrong,
  },
  composerChoices: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
  },
  choiceButton: {
    minWidth: 0,
    maxWidth: "58%",
    minHeight: 36,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 7,
    borderRadius: radius.pill,
  },
  choiceButtonText: {
    ...typography.caption,
    color: colors.textSecondary,
    flexShrink: 1,
  },
  choiceButtonPrimaryText: { color: colors.primaryStrong },
  sendButton: {
    width: 38,
    height: 38,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.pill,
    backgroundColor: colors.primary,
  },
  sendButtonDisabled: { backgroundColor: colors.surfaceStrong },
  drawerBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.58)",
  },
  drawer: {
    width: "88%",
    maxWidth: 390,
    height: "100%",
    backgroundColor: "#242322",
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: colors.border,
    shadowColor: "#000",
    shadowOpacity: 0.42,
    shadowRadius: 24,
    shadowOffset: { width: 10, height: 0 },
  },
  drawerSafe: { flex: 1 },
  drawerHeader: {
    height: 62,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  beziMark: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
    backgroundColor: colors.primary,
  },
  beziMarkText: {
    color: colors.primaryInk,
    fontSize: 14,
    fontWeight: "800",
  },
  drawerBrand: {
    ...typography.heading,
    color: colors.text,
    flex: 1,
    fontSize: 17,
  },
  drawerClose: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  drawerProject: {
    minHeight: 62,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    marginHorizontal: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
  },
  drawerProjectSecondary: {
    marginTop: spacing.sm,
  },
  drawerProjectTitle: { ...typography.label, color: colors.text },
  drawerProjectPath: { ...typography.caption, color: colors.textMuted },
  drawerNewThread: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    marginHorizontal: spacing.md,
    marginTop: spacing.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surfaceStrong,
  },
  drawerNewThreadText: { ...typography.label, color: colors.text },
  drawerScroll: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.lg,
  },
  drawerNavigation: {
    gap: 2,
    paddingBottom: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSoft,
  },
  drawerNavItem: {
    minHeight: 46,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: 10,
  },
  drawerNavItemActive: { backgroundColor: "#4A4846" },
  drawerNavText: { ...typography.body, color: colors.textSecondary },
  drawerNavTextActive: { color: colors.text, fontWeight: "600" },
  drawerSectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.md,
    paddingTop: spacing.lg,
    paddingBottom: spacing.sm,
  },
  drawerSectionTitle: {
    ...typography.caption,
    color: colors.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  drawerSectionCount: { ...typography.caption, color: colors.textMuted },
  drawerEmpty: {
    ...typography.caption,
    color: colors.textMuted,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.lg,
  },
  drawerThread: {
    minHeight: 54,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: 10,
  },
  drawerThreadActive: { backgroundColor: colors.surfaceStrong },
  drawerThreadTitle: { ...typography.label, color: colors.text },
  drawerThreadMeta: { ...typography.caption, color: colors.textMuted },
  controlButton: {
    minHeight: 62,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    margin: spacing.md,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
  },
  controlButtonActive: {
    borderColor: colors.primary,
    backgroundColor: colors.primary,
  },
  controlButtonTitle: { ...typography.label, color: colors.text },
  controlButtonTitleActive: { color: colors.primaryInk },
  controlButtonMeta: { ...typography.caption, color: colors.textMuted },
  controlButtonMetaActive: { color: "#575064" },
  workspaceScroll: {
    flexGrow: 1,
    paddingBottom: Platform.OS === "ios" ? 116 : 96,
  },
  workspace: { gap: spacing.xl },
  workspaceIntro: {
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xxxl,
    paddingBottom: spacing.md,
  },
  workspaceIntroCompact: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  workspaceIcon: {
    width: 48,
    height: 48,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.lg,
    backgroundColor: "#302D35",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#484252",
  },
  workspaceTitle: {
    ...typography.title,
    color: colors.text,
    fontSize: 27,
    lineHeight: 32,
  },
  workspaceCopy: {
    ...typography.body,
    color: colors.textSecondary,
    textAlign: "center",
    maxWidth: 340,
  },
  libraryList: {
    gap: spacing.xs,
    paddingHorizontal: spacing.lg,
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  sectionLabel: {
    ...typography.caption,
    color: colors.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.8,
    paddingHorizontal: spacing.xs,
    paddingBottom: spacing.sm,
  },
  sectionCount: { ...typography.caption, color: colors.textMuted },
  documentRow: {
    minHeight: 72,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSoft,
    backgroundColor: colors.surface,
  },
  folderRow: {
    minHeight: 66,
    borderColor: "#46414F",
    backgroundColor: "#29272D",
  },
  documentIcon: {
    width: 42,
    height: 42,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 12,
    backgroundColor: "#34313A",
  },
  folderIcon: {
    backgroundColor: "#3A3544",
  },
  documentTitle: {
    ...typography.label,
    color: colors.text,
    fontSize: 14,
    lineHeight: 19,
  },
  documentMeta: {
    ...typography.caption,
    color: colors.textMuted,
    marginTop: 2,
  },
  workspaceItemIcon: {
    width: 38,
    height: 38,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 11,
    backgroundColor: "#34313A",
  },
  workspaceItemTitle: { ...typography.label, color: colors.text },
  workspaceItemMeta: {
    ...typography.caption,
    color: colors.textMuted,
    marginTop: 2,
  },
  skillRow: {
    minHeight: 62,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSoft,
    backgroundColor: colors.surface,
  },
  planCallout: {
    minHeight: 70,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: "#302D35",
    marginBottom: spacing.sm,
  },
  emptyCollection: {
    minHeight: 90,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.xl,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSoft,
    backgroundColor: colors.surface,
  },
  emptyCollectionText: {
    ...typography.body,
    color: colors.textMuted,
    textAlign: "center",
  },
  fullRemoteCallout: {
    minHeight: 74,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    marginHorizontal: spacing.lg,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSoft,
  },
  fullRemoteTitle: { ...typography.label, color: colors.textSecondary },
  fullRemoteCopy: {
    ...typography.caption,
    color: colors.textMuted,
    marginTop: 2,
  },
  remoteView: {
    gap: spacing.lg,
    paddingTop: spacing.lg,
    paddingHorizontal: spacing.md,
  },
  sheetBackdrop: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(0,0,0,0.62)",
  },
  sheet: {
    maxHeight: "84%",
    paddingTop: spacing.sm,
    paddingBottom: Platform.OS === "ios" ? spacing.xxxl : spacing.lg,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.background,
  },
  sheetHandle: {
    width: 38,
    height: 4,
    alignSelf: "center",
    borderRadius: 2,
    backgroundColor: colors.border,
  },
  sheetHeader: {
    minHeight: 58,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
  },
  sheetTitle: { ...typography.heading, color: colors.text },
  sheetClose: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.md,
  },
  sheetBody: {
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.lg,
  },
  sheetEmpty: {
    ...typography.body,
    color: colors.textMuted,
    textAlign: "center",
    padding: spacing.xl,
  },
  pickerRow: {
    minHeight: 62,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
  },
  pickerRowActive: { backgroundColor: colors.surfaceStrong },
  pickerTitle: { ...typography.label, color: colors.text },
  pickerMeta: { ...typography.caption, color: colors.textMuted },
});
