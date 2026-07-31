import { useCallback, useEffect, useMemo, useRef } from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { colors, radius } from "@/theme/tokens";

export type WebRtcSignal =
  | { type: "offer"; sdp: RTCSessionDescriptionInit }
  | { type: "ice"; candidate: RTCIceCandidateInit }
  | { type: "config"; iceServers: RTCIceServer[] };

export function RemoteSurface({
  signal,
  onSignal,
  controlEnabled,
}: {
  signal?: WebRtcSignal;
  onSignal?: (message: Record<string, unknown>) => void;
  controlEnabled: boolean;
}) {
  const webView = useRef<WebView>(null);
  const source = useMemo(() => ({ html: viewerHtml }), []);

  const handleMessage = useCallback(
    (event: WebViewMessageEvent) => {
      try {
        onSignal?.(JSON.parse(event.nativeEvent.data) as Record<string, unknown>);
      } catch {
        onSignal?.({ type: "viewer.error", message: "Malformed viewer event" });
      }
    },
    [onSignal],
  );

  useEffect(() => {
    if (signal) {
      webView.current?.postMessage(JSON.stringify({ type: "signal", payload: signal }));
    }
  }, [signal]);

  useEffect(() => {
    webView.current?.postMessage(
      JSON.stringify({ type: "control", enabled: controlEnabled }),
    );
  }, [controlEnabled]);

  if (Platform.OS === "web") {
    return (
      <View style={[styles.frame, styles.webFallback]}>
        <View style={styles.fallbackGlow} />
        <View style={styles.fallbackMark}>
          <View style={styles.fallbackRing} />
        </View>
        <Text style={styles.fallbackTitle}>Waiting for the Windows companion</Text>
        <Text style={styles.fallbackMeta}>Encrypted WebRTC preview</Text>
      </View>
    );
  }

  return (
    <View style={styles.frame}>
      <WebView
        ref={webView}
        source={source}
        originWhitelist={["*"]}
        javaScriptEnabled
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        scrollEnabled={false}
        bounces={false}
        onMessage={handleMessage}
        style={styles.webView}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    aspectRatio: 16 / 10,
    overflow: "hidden",
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.backgroundDeep,
  },
  webView: { flex: 1, backgroundColor: colors.backgroundDeep },
  webFallback: { alignItems: "center", justifyContent: "center" },
  fallbackGlow: {
    position: "absolute",
    width: 190,
    height: 190,
    borderRadius: 95,
    backgroundColor: "rgba(184,176,221,0.06)",
  },
  fallbackMark: {
    width: 58,
    height: 58,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  fallbackRing: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 5,
    borderColor: colors.primary,
    borderTopColor: "transparent",
  },
  fallbackTitle: {
    marginTop: 14,
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "600",
  },
  fallbackMeta: { marginTop: 3, color: colors.textMuted, fontSize: 10 },
});

const viewerHtml = String.raw`<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<style>
*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#151413;color:#f2efe9;font-family:-apple-system,BlinkMacSystemFont,sans-serif}
#video{width:100%;height:100%;object-fit:contain;background:#111;display:none}
#idle{position:absolute;inset:0;display:grid;place-items:center;background:
radial-gradient(circle at 50% 45%,rgba(214,207,242,.1),transparent 34%),
linear-gradient(rgba(255,255,255,.025) 1px,transparent 1px),
linear-gradient(90deg,rgba(255,255,255,.025) 1px,transparent 1px);background-size:auto,28px 28px,28px 28px}
.mark{width:62px;height:62px;border:1px solid #48443f;border-radius:10px;display:grid;place-items:center;background:#242321;box-shadow:0 12px 32px rgba(0,0,0,.28)}
.mark:before{content:"";width:22px;height:22px;border:5px solid #d6cff2;border-top-color:transparent;border-radius:50%}
.copy{position:absolute;top:calc(50% + 50px);left:0;right:0;text-align:center;color:#89837a;font-size:12px;letter-spacing:.2px}
#live{position:absolute;top:10px;left:10px;padding:6px 9px;border-radius:999px;background:rgba(20,19,19,.75);font-size:10px;display:none}
#live:before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;background:#4ccb84;margin-right:6px}
</style>
</head>
<body>
<video id="video" autoplay playsinline></video>
<div id="idle"><div class="mark"></div><div class="copy">Waiting for the Windows companion</div></div>
<div id="live">LIVE</div>
<script>
const send=(value)=>window.ReactNativeWebView?.postMessage(JSON.stringify(value));
let pc=null,control=false,channel=null,pendingIce=[];
const video=document.getElementById("video"),idle=document.getElementById("idle"),live=document.getElementById("live");
async function ensure(iceServers=[]){
 if(pc&&!["failed","closed"].includes(pc.connectionState))return pc;
 if(pc)pc.close();
 pc=new RTCPeerConnection({iceServers,bundlePolicy:"max-bundle"});
 pc.ontrack=e=>{video.srcObject=e.streams[0];video.style.display="block";idle.style.display="none";live.style.display="block";video.play().catch(error=>send({type:"viewer.audio-blocked",message:error.message}));send({type:"viewer.track",kind:e.track.kind})};
 pc.onicecandidate=e=>e.candidate&&send({type:"viewer.ice",candidate:e.candidate});
 pc.ondatachannel=e=>{channel=e.channel;channel.onopen=()=>send({type:"viewer.data-open"})};
 pc.onconnectionstatechange=()=>send({type:"viewer.state",state:pc.connectionState});
 return pc;
}
async function signal(value){
 if(value.type==="config"){const peer=await ensure(value.iceServers);peer.setConfiguration({iceServers:value.iceServers});return}
 const peer=await ensure();
 if(value.type==="offer"){
  await peer.setRemoteDescription(value.sdp);
  for(const candidate of pendingIce.splice(0))await peer.addIceCandidate(candidate);
  const answer=await peer.createAnswer();
  await peer.setLocalDescription(answer);
  send({type:"viewer.answer",sdp:peer.localDescription});
 }else if(value.type==="ice"){
  if(peer.remoteDescription)await peer.addIceCandidate(value.candidate);
  else pendingIce.push(value.candidate);
 }
}
let lastTouch=null,pointerDown=false;
function emitInput(value){
 if(!control||!channel||channel.readyState!=="open")return;
 channel.send(JSON.stringify(value));
}
function input(event){
 if(!control||!channel||channel.readyState!=="open")return;
 const touch=event.touches?.[0]||event.changedTouches?.[0];
 if(!touch)return;
 if(event.type==="touchstart"){
  lastTouch={x:touch.clientX,y:touch.clientY};
  pointerDown=true;
  emitInput({event:"pointerButton",button:"left",down:true});
 }else if(event.type==="touchmove"&&lastTouch){
  const dx=Math.max(-32768,Math.min(32768,Math.round((touch.clientX-lastTouch.x)*1.5)));
  const dy=Math.max(-32768,Math.min(32768,Math.round((touch.clientY-lastTouch.y)*1.5)));
  lastTouch={x:touch.clientX,y:touch.clientY};
  if(dx||dy)emitInput({event:"pointerMove",dx,dy});
 }else if(pointerDown){
  emitInput({event:"pointerButton",button:"left",down:false});
  pointerDown=false;
  lastTouch=null;
 }
 event.preventDefault();
}
["touchstart","touchmove","touchend","touchcancel"].forEach(name=>document.addEventListener(name,input,{passive:false}));
function receive(event){
 try{const message=JSON.parse(event.data);if(message.type==="signal")signal(message.payload).catch(error=>send({type:"viewer.error",message:error.message}));if(message.type==="control")control=!!message.enabled}catch{}
}
window.addEventListener("message",receive);document.addEventListener("message",receive);
send({type:"viewer.ready",webrtc:!!window.RTCPeerConnection});
</script>
</body>
</html>`;
