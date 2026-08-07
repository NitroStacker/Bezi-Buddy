use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    time::Duration,
};

use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_sdp as gst_sdp;
use gstreamer_webrtc as gst_webrtc;
use serde_json::{json, Value};
use tokio::sync::broadcast;
#[cfg(test)]
use uuid::Uuid;

use crate::{
    control::ControlState,
    stream::{
        find_target_window, CaptureRegion, CaptureWindow, StreamEvent, StreamPreset, StreamStatus,
    },
};

const STUN_URI: &str = "stun://stun.cloudflare.com:3478";

#[derive(Clone)]
pub struct NativeMediaManager {
    sessions: Arc<Mutex<HashMap<String, NativeSession>>>,
    events: broadcast::Sender<StreamEvent>,
    control: Arc<ControlState>,
}

struct NativeSession {
    pipeline: gst::Pipeline,
    peer: gst::Element,
    _input_channel: Option<gst_webrtc::WebRTCDataChannel>,
    remote_description_set: AtomicBool,
    pending_remote_ice: Mutex<Vec<(u32, String)>>,
    local_offer: Arc<Mutex<Option<String>>>,
    bus_stop: Arc<AtomicBool>,
    bus_thread: Option<std::thread::JoinHandle<()>>,
}

impl NativeSession {
    fn stop(self) {
        let NativeSession {
            pipeline,
            peer,
            _input_channel: input_channel,
            bus_stop,
            bus_thread,
            remote_description_set,
            local_offer,
            ..
        } = self;
        bus_stop.store(true, Ordering::Release);
        if let Some(thread) = bus_thread {
            let _ = thread.join();
        }
        drop(input_channel);

        let mut drain_receiver = None;
        let can_release = if remote_description_set.load(Ordering::Acquire) {
            true
        } else {
            let offer = local_offer
                .lock()
                .ok()
                .and_then(|value| value.as_ref().cloned());
            offer
                .and_then(|offer| create_drain_answer(&offer).ok())
                .is_some_and(|(answer, receiver_pipeline)| {
                    let message = gst_sdp::SDPMessage::parse_buffer(answer.as_bytes()).ok();
                    if let Some(message) = message {
                        let answer = gst_webrtc::WebRTCSessionDescription::new(
                            gst_webrtc::WebRTCSDPType::Answer,
                            message,
                        );
                        peer.emit_by_name::<()>(
                            "set-remote-description",
                            &[&answer, &None::<gst::Promise>],
                        );
                        drain_receiver = Some(receiver_pipeline);
                        true
                    } else {
                        false
                    }
                })
        };

        if can_release {
            std::thread::sleep(Duration::from_millis(300));
        }
        let _ = pipeline.set_state(gst::State::Ready);
        let _ = pipeline.state(Some(gst::ClockTime::from_seconds(2)));
        if !can_release {
            // GStreamer 1.28 on Windows can corrupt its heap if a half-created
            // WebRTC offer is destroyed before any answer exists. READY stops
            // capture/encoding; retaining this rare incomplete graph is safer
            // than terminating the companion process.
            std::mem::forget(peer);
            std::mem::forget(pipeline);
            return;
        }
        let _ = peer.set_state(gst::State::Null);
        let _ = pipeline.set_state(gst::State::Null);
        drop(peer);
        drop(pipeline);
        if let Some(receiver_pipeline) = drain_receiver {
            let _ = receiver_pipeline.set_state(gst::State::Null);
        }
    }
}

impl NativeMediaManager {
    pub fn new(control: Arc<ControlState>) -> Result<Self, String> {
        gst::init().map_err(|error| format!("GStreamer initialization failed: {error}"))?;
        let (events, _) = broadcast::channel(256);
        Ok(Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            events,
            control,
        })
    }

    pub fn subscribe(&self) -> broadcast::Receiver<StreamEvent> {
        self.events.subscribe()
    }

    pub fn start(
        &self,
        device_id: &str,
        request_id: &str,
        process_id: u32,
        region: Option<CaptureRegion>,
        preset: StreamPreset,
        status: &StreamStatus,
    ) -> Result<(), String> {
        self.stop(device_id);

        let window = find_target_window(process_id)?;
        let pipeline_description = build_pipeline(window, region, preset, status)?;
        let pipeline = gst::parse::launch(&pipeline_description)
            .map_err(|error| format!("Could not construct the WebRTC pipeline: {error}"))?
            .downcast::<gst::Pipeline>()
            .map_err(|_| "GStreamer did not create a pipeline".to_owned())?;
        let peer = pipeline
            .by_name("peer")
            .ok_or_else(|| "The WebRTC pipeline is missing webrtcbin".to_owned())?;
        let local_offer = Arc::new(Mutex::new(None));

        connect_signaling(
            &peer,
            self.events.clone(),
            device_id.to_owned(),
            request_id.to_owned(),
            local_offer.clone(),
        );
        let (bus_stop, bus_thread) = connect_bus(
            &pipeline,
            self.events.clone(),
            device_id.to_owned(),
            request_id.to_owned(),
        )?;

        pipeline
            .set_state(gst::State::Ready)
            .map_err(|error| format!("The capture pipeline could not become ready: {error:?}"))?;

        let input_channel = Some(
            peer.emit_by_name::<Option<gst_webrtc::WebRTCDataChannel>>(
                "create-data-channel",
                &[&"bezi-remote-input", &None::<gst::Structure>],
            )
            .ok_or_else(|| {
                "GStreamer could not create the input DataChannel; verify the SCTP plugin"
                    .to_owned()
            })?,
        );
        if let Some(input_channel) = &input_channel {
            connect_input_channel(
                input_channel,
                self.control.clone(),
                self.events.clone(),
                device_id.to_owned(),
                request_id.to_owned(),
            );
        }

        let _ = self.events.send(StreamEvent::new(
            device_id,
            request_id,
            "stream.config",
            json!({
                "iceServers": [
                    { "urls": ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"] }
                ]
            }),
        ));

        pipeline
            .set_state(gst::State::Playing)
            .map_err(|error| format!("The capture pipeline could not start: {error:?}"))?;

        let session = NativeSession {
            pipeline,
            peer,
            _input_channel: input_channel,
            remote_description_set: AtomicBool::new(false),
            pending_remote_ice: Mutex::new(Vec::new()),
            local_offer,
            bus_stop,
            bus_thread: Some(bus_thread),
        };
        self.sessions
            .lock()
            .map_err(|_| "Media session state is unavailable".to_owned())?
            .insert(device_id.to_owned(), session);
        Ok(())
    }

    pub fn set_answer(&self, device_id: &str, sdp: &str) -> Result<(), String> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| "Media session state is unavailable".to_owned())?;
        let session = sessions
            .get(device_id)
            .ok_or_else(|| "No active media session exists for this phone".to_owned())?;
        let message = gst_sdp::SDPMessage::parse_buffer(sdp.as_bytes())
            .map_err(|_| "The viewer returned an invalid SDP answer".to_owned())?;
        let answer =
            gst_webrtc::WebRTCSessionDescription::new(gst_webrtc::WebRTCSDPType::Answer, message);
        session
            .peer
            .emit_by_name::<()>("set-remote-description", &[&answer, &None::<gst::Promise>]);
        session
            .remote_description_set
            .store(true, Ordering::Release);
        let candidates = session
            .pending_remote_ice
            .lock()
            .map_err(|_| "Pending ICE state is unavailable".to_owned())?
            .drain(..)
            .collect::<Vec<_>>();
        for (index, candidate) in candidates {
            session
                .peer
                .emit_by_name::<()>("add-ice-candidate", &[&index, &candidate]);
        }
        Ok(())
    }

    pub fn add_ice_candidate(
        &self,
        device_id: &str,
        sdp_m_line_index: u32,
        candidate: &str,
    ) -> Result<(), String> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| "Media session state is unavailable".to_owned())?;
        let session = sessions
            .get(device_id)
            .ok_or_else(|| "No active media session exists for this phone".to_owned())?;
        if !session.remote_description_set.load(Ordering::Acquire) {
            session
                .pending_remote_ice
                .lock()
                .map_err(|_| "Pending ICE state is unavailable".to_owned())?
                .push((sdp_m_line_index, candidate.to_owned()));
            return Ok(());
        }
        session
            .peer
            .emit_by_name::<()>("add-ice-candidate", &[&sdp_m_line_index, &candidate]);
        Ok(())
    }

    pub fn stop(&self, device_id: &str) {
        if let Ok(mut sessions) = self.sessions.lock() {
            if let Some(session) = sessions.remove(device_id) {
                session.stop();
            }
        }
    }

    pub fn stop_all(&self) {
        if let Ok(mut sessions) = self.sessions.lock() {
            for (_, session) in sessions.drain() {
                session.stop();
            }
        }
    }
}

fn build_pipeline(
    window: CaptureWindow,
    region: Option<CaptureRegion>,
    preset: StreamPreset,
    status: &StreamStatus,
) -> Result<String, String> {
    let capture = status
        .capture_backend
        .as_deref()
        .ok_or_else(|| "A Windows Graphics Capture plugin is not installed".to_owned())?;
    let encoder = status
        .encoder
        .as_deref()
        .ok_or_else(|| "An H.264 encoder plugin is not installed".to_owned())?;
    let audio = status
        .audio_backend
        .as_deref()
        .ok_or_else(|| "A WASAPI capture plugin is not installed".to_owned())?;
    let profile = preset.profile();
    let crop = window.crop(region)?.map_or_else(String::new, |crop| {
        format!(
            "videocrop left={} top={} right={} bottom={} ! ",
            crop.left, crop.top, crop.right, crop.bottom
        )
    });
    let window_handle = window.handle;

    let (capture_chain, raw_caps) = match capture {
        "d3d12screencapturesrc" => (
            format!(
                "d3d12screencapturesrc window-handle={window_handle} \
                 window-capture-mode=client show-cursor=true show-border=false"
            ),
            format!(
                "d3d12convert ! video/x-raw(memory:D3D12Memory),format=NV12,width={},height={},framerate={}/1",
                profile.width, profile.height, profile.fps
            ),
        ),
        "d3d11screencapturesrc" => (
            format!(
                "d3d11screencapturesrc capture-api=wgc window-handle={window_handle} \
                 window-capture-mode=client show-cursor=true show-border=false"
            ),
            format!(
                "d3d11convert ! d3d11download ! videoconvert ! \
                 video/x-raw,format=NV12,width={},height={},framerate={}/1",
                profile.width, profile.height, profile.fps
            ),
        ),
        other => return Err(format!("Unsupported Windows capture backend: {other}")),
    };

    let encoder_chain = match encoder {
        "nvh264enc" => format!(
            "nvh264enc bitrate={} gop-size={} bframes=0 zerolatency=true",
            profile.bitrate_kbps, profile.fps
        ),
        "mfh264enc" => format!(
            "mfh264enc bitrate={} low-latency=true",
            profile.bitrate_kbps * 1_000
        ),
        "openh264enc" => format!(
            "openh264enc bitrate={} complexity=low",
            profile.bitrate_kbps * 1_000
        ),
        "x264enc" => format!(
            "x264enc bitrate={} tune=zerolatency speed-preset=veryfast key-int-max={}",
            profile.bitrate_kbps, profile.fps
        ),
        other => {
            return Err(format!(
                "The installed H.264 encoder is not configured for streaming: {other}"
            ))
        }
    };

    Ok(format!(
        "webrtcbin name=peer bundle-policy=max-bundle latency=0 stun-server={STUN_URI} \
         {capture_chain} ! queue max-size-buffers=1 leaky=downstream ! {crop}{raw_caps} ! \
         {encoder_chain} ! h264parse config-interval=-1 ! \
         rtph264pay pt=96 config-interval=-1 aggregate-mode=zero-latency ! \
         application/x-rtp,media=video,encoding-name=H264,payload=96 ! peer. \
         {audio} loopback=true low-latency=true ! \
         queue max-size-buffers=2 leaky=downstream ! audioconvert ! audioresample ! \
         opusenc bitrate=128000 frame-size=10 ! rtpopuspay pt=97 ! \
         application/x-rtp,media=audio,encoding-name=OPUS,payload=97 ! peer."
    ))
}

fn connect_signaling(
    peer: &gst::Element,
    events: broadcast::Sender<StreamEvent>,
    device_id: String,
    request_id: String,
    local_offer: Arc<Mutex<Option<String>>>,
) {
    let offer_started = Arc::new(AtomicBool::new(false));
    let peer_for_offer = peer.clone();
    let offer_events = events.clone();
    let offer_device = device_id.clone();
    let offer_request = request_id.clone();
    peer.connect("on-negotiation-needed", false, move |_| {
        if offer_started.swap(true, Ordering::AcqRel) {
            return None;
        }
        let peer_for_description = peer_for_offer.clone();
        let events = offer_events.clone();
        let device_id = offer_device.clone();
        let request_id = offer_request.clone();
        let local_offer = local_offer.clone();
        let promise = gst::Promise::with_change_func(move |reply| {
            let result = (|| -> Result<(), String> {
                let reply = reply
                    .map_err(|error| format!("Offer creation failed: {error:?}"))?
                    .ok_or_else(|| "Offer creation returned no SDP".to_owned())?;
                let offer = reply
                    .value("offer")
                    .map_err(|_| "Offer creation returned no offer".to_owned())?
                    .get::<gst_webrtc::WebRTCSessionDescription>()
                    .map_err(|_| "Offer creation returned an invalid offer".to_owned())?;
                peer_for_description
                    .emit_by_name::<()>("set-local-description", &[&offer, &None::<gst::Promise>]);
                let sdp = offer
                    .sdp()
                    .as_text()
                    .map_err(|_| "Could not serialize the SDP offer".to_owned())?;
                if let Ok(mut value) = local_offer.lock() {
                    *value = Some(sdp.clone());
                }
                let _ = events.send(StreamEvent::new(
                    &device_id,
                    &request_id,
                    "stream.offer",
                    json!({ "sdp": { "type": "offer", "sdp": sdp } }),
                ));
                Ok(())
            })();
            if let Err(message) = result {
                let _ = events.send(StreamEvent::new(
                    &device_id,
                    &request_id,
                    "stream.error",
                    json!({ "code": "offer_failed", "message": message }),
                ));
            }
        });
        peer_for_offer.emit_by_name::<()>("create-offer", &[&None::<gst::Structure>, &promise]);
        None
    });

    peer.connect("on-ice-candidate", false, move |values| {
        let Some(index) = values.get(1).and_then(|value| value.get::<u32>().ok()) else {
            return None;
        };
        let Some(candidate) = values.get(2).and_then(|value| value.get::<String>().ok()) else {
            return None;
        };
        let _ = events.send(StreamEvent::new(
            &device_id,
            &request_id,
            "stream.ice",
            json!({
                "candidate": {
                    "candidate": candidate,
                    "sdpMLineIndex": index
                }
            }),
        ));
        None
    });
}

fn create_drain_answer(offer_sdp: &str) -> Result<(String, gst::Pipeline), String> {
    let receiver = gst::parse::launch("webrtcbin name=receiver bundle-policy=max-bundle latency=0")
        .map_err(|error| format!("Could not create WebRTC cleanup peer: {error}"))?;
    let receiver_pipeline = gst::Pipeline::new();
    receiver_pipeline
        .add(&receiver)
        .map_err(|error| format!("Could not attach WebRTC cleanup peer: {error}"))?;
    receiver_pipeline
        .set_state(gst::State::Playing)
        .map_err(|error| format!("Could not start WebRTC cleanup peer: {error:?}"))?;

    let offer_message = gst_sdp::SDPMessage::parse_buffer(offer_sdp.as_bytes())
        .map_err(|_| "Could not parse the pending WebRTC offer".to_owned())?;
    let offer =
        gst_webrtc::WebRTCSessionDescription::new(gst_webrtc::WebRTCSDPType::Offer, offer_message);
    receiver.emit_by_name::<()>("set-remote-description", &[&offer, &None::<gst::Promise>]);

    let (answer_tx, answer_rx) = mpsc::channel();
    let receiver_for_answer = receiver.clone();
    let promise = gst::Promise::with_change_func(move |reply| {
        let result = (|| -> Result<String, String> {
            let reply = reply
                .map_err(|error| format!("Cleanup answer failed: {error:?}"))?
                .ok_or_else(|| "Cleanup answer returned no SDP".to_owned())?;
            let answer = reply
                .value("answer")
                .map_err(|_| "Cleanup answer is missing".to_owned())?
                .get::<gst_webrtc::WebRTCSessionDescription>()
                .map_err(|_| "Cleanup answer is invalid".to_owned())?;
            receiver_for_answer
                .emit_by_name::<()>("set-local-description", &[&answer, &None::<gst::Promise>]);
            answer
                .sdp()
                .as_text()
                .map_err(|_| "Could not serialize cleanup answer".to_owned())
        })();
        let _ = answer_tx.send(result);
    });
    receiver.emit_by_name::<()>("create-answer", &[&None::<gst::Structure>, &promise]);
    let answer = answer_rx
        .recv_timeout(Duration::from_secs(2))
        .map_err(|_| "Timed out creating the WebRTC cleanup answer".to_owned())??;
    Ok((answer, receiver_pipeline))
}

fn connect_input_channel(
    channel: &gst_webrtc::WebRTCDataChannel,
    control: Arc<ControlState>,
    events: broadcast::Sender<StreamEvent>,
    device_id: String,
    request_id: String,
) {
    channel.connect_on_message_string(move |_, message| {
        let Some(message) = message else {
            return;
        };
        let result = serde_json::from_str::<Value>(message)
            .map_err(|_| "The input DataChannel sent invalid JSON".to_owned())
            .and_then(|body| control.apply_remote_input(&body));
        if let Err(message) = result {
            let _ = events.send(StreamEvent::new(
                &device_id,
                &request_id,
                "remote.error",
                json!({ "code": "input_rejected", "message": message }),
            ));
        }
    });
}

fn connect_bus(
    pipeline: &gst::Pipeline,
    events: broadcast::Sender<StreamEvent>,
    device_id: String,
    request_id: String,
) -> Result<(Arc<AtomicBool>, std::thread::JoinHandle<()>), String> {
    let bus = pipeline
        .bus()
        .ok_or_else(|| "The capture pipeline did not create a message bus".to_owned())?;
    let stop = Arc::new(AtomicBool::new(false));
    let monitor_stop = stop.clone();
    let thread = std::thread::Builder::new()
        .name("bezi-remote-gstreamer".to_owned())
        .spawn(move || {
            while !monitor_stop.load(Ordering::Acquire) {
                let Some(message) = bus.timed_pop(gst::ClockTime::from_mseconds(100)) else {
                    continue;
                };
                use gst::MessageView;
                match message.view() {
                    MessageView::Error(error) => {
                        let _ = events.send(StreamEvent::new(
                            &device_id,
                            &request_id,
                            "stream.error",
                            json!({
                                "code": "pipeline_failed",
                                "message": error.error().to_string(),
                                "debug": error.debug().map(|value| value.to_string())
                            }),
                        ));
                        monitor_stop.store(true, Ordering::Release);
                        break;
                    }
                    MessageView::Eos(..) => break,
                    _ => {}
                }
            }
        })
        .map_err(|error| format!("Could not start the media monitor: {error}"))?;
    Ok((stop, thread))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stream;
    use std::sync::{
        atomic::{AtomicUsize, Ordering as AtomicOrdering},
        mpsc,
    };
    use std::time::Duration;

    #[tokio::test]
    #[ignore = "requires an interactive Windows process and the installed GStreamer runtime"]
    async fn media_pipeline_emits_h264_opus_offer() {
        let process_id = std::env::var("BEZI_REMOTE_STREAM_TEST_PID")
            .expect("set BEZI_REMOTE_STREAM_TEST_PID to a visible application process")
            .parse::<u32>()
            .expect("BEZI_REMOTE_STREAM_TEST_PID must be a process ID");
        let control = Arc::new(ControlState::default());
        let manager = NativeMediaManager::new(control).expect("GStreamer should initialize");
        let mut events = manager.subscribe();
        let request_id = Uuid::new_v4().to_string();
        manager
            .start(
                "test-device",
                &request_id,
                process_id,
                None,
                StreamPreset::Balanced,
                &stream::probe(),
            )
            .expect("media pipeline should start");

        let sdp = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let event = events.recv().await.expect("media event channel closed");
                assert_eq!(event.request_id, request_id);
                if event.message_type == "stream.error" {
                    panic!("media pipeline failed: {}", event.body);
                }
                if event.message_type == "stream.offer" {
                    break event
                        .body
                        .pointer("/sdp/sdp")
                        .and_then(Value::as_str)
                        .expect("offer should contain SDP")
                        .to_owned();
                }
            }
        })
        .await
        .expect("media offer timed out");

        assert!(sdp.contains("m=video"));
        assert!(sdp.contains("H264"));
        assert!(sdp.contains("m=audio"));
        assert!(sdp.contains("OPUS"));

        let receiver =
            gst::parse::launch("webrtcbin name=receiver bundle-policy=max-bundle latency=0")
                .expect("receiver webrtcbin should parse");
        let receiver_pipeline = gst::Pipeline::new();
        receiver_pipeline
            .add(&receiver)
            .expect("receiver should be added to its pipeline");
        let video_buffers = Arc::new(AtomicUsize::new(0));
        let audio_buffers = Arc::new(AtomicUsize::new(0));
        let receiver_pipeline_for_pad = receiver_pipeline.clone();
        let video_buffers_for_pad = video_buffers.clone();
        let audio_buffers_for_pad = audio_buffers.clone();
        let pad_handler = receiver.connect("pad-added", false, move |values| {
            let Some(pad) = values.get(1).and_then(|value| value.get::<gst::Pad>().ok()) else {
                return None;
            };
            let caps = pad.current_caps().unwrap_or_else(|| pad.query_caps(None));
            let media = caps
                .structure(0)
                .and_then(|structure| structure.get::<String>("media").ok())
                .unwrap_or_default();
            let counter = match media.as_str() {
                "video" => video_buffers_for_pad.clone(),
                "audio" => audio_buffers_for_pad.clone(),
                _ => return None,
            };
            let queue = gst::ElementFactory::make("queue")
                .build()
                .expect("receiver queue should build");
            let sink = gst::ElementFactory::make("fakesink")
                .property("sync", false)
                .property("signal-handoffs", true)
                .build()
                .expect("receiver sink should build");
            sink.connect("handoff", false, move |_| {
                counter.fetch_add(1, AtomicOrdering::Relaxed);
                None
            });
            receiver_pipeline_for_pad
                .add_many([&queue, &sink])
                .expect("receiver elements should attach");
            queue.link(&sink).expect("receiver queue should link");
            queue
                .sync_state_with_parent()
                .expect("receiver queue should synchronize");
            sink.sync_state_with_parent()
                .expect("receiver sink should synchronize");
            pad.link(
                &queue
                    .static_pad("sink")
                    .expect("receiver queue should expose a sink pad"),
            )
            .expect("incoming RTP pad should link");
            None
        });
        let (receiver_ice_tx, receiver_ice_rx) = mpsc::channel();
        receiver.connect("on-ice-candidate", false, move |values| {
            let index = values[1].get::<u32>().expect("ICE index should be valid");
            let candidate = values[2]
                .get::<String>()
                .expect("ICE candidate should be valid");
            let _ = receiver_ice_tx.send((index, candidate));
            None
        });
        receiver_pipeline
            .set_state(gst::State::Playing)
            .expect("receiver pipeline should start");

        let offer_message =
            gst_sdp::SDPMessage::parse_buffer(sdp.as_bytes()).expect("offer SDP should parse");
        let offer = gst_webrtc::WebRTCSessionDescription::new(
            gst_webrtc::WebRTCSDPType::Offer,
            offer_message,
        );
        receiver.emit_by_name::<()>("set-remote-description", &[&offer, &None::<gst::Promise>]);

        let (answer_tx, answer_rx) = mpsc::channel();
        let receiver_for_answer = receiver.clone();
        let promise = gst::Promise::with_change_func(move |reply| {
            let reply = reply
                .expect("answer promise should succeed")
                .expect("answer promise should contain a reply");
            let answer = reply
                .value("answer")
                .expect("answer value should exist")
                .get::<gst_webrtc::WebRTCSessionDescription>()
                .expect("answer value should be a session description");
            receiver_for_answer
                .emit_by_name::<()>("set-local-description", &[&answer, &None::<gst::Promise>]);
            answer_tx
                .send(answer.sdp().as_text().expect("answer SDP should serialize"))
                .expect("answer channel should stay open");
        });
        receiver.emit_by_name::<()>("create-answer", &[&None::<gst::Structure>, &promise]);
        let answer = answer_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("receiver answer should be created");
        manager
            .set_answer("test-device", &answer)
            .expect("sender should accept receiver answer");

        let deadline = std::time::Instant::now() + Duration::from_secs(6);
        while std::time::Instant::now() < deadline {
            while let Ok((index, candidate)) = receiver_ice_rx.try_recv() {
                manager
                    .add_ice_candidate("test-device", index, &candidate)
                    .expect("sender should accept receiver ICE");
            }
            if let Ok(Ok(event)) =
                tokio::time::timeout(Duration::from_millis(100), events.recv()).await
            {
                if event.message_type == "stream.ice" {
                    assert_eq!(event.request_id, request_id);
                    let index = event
                        .body
                        .pointer("/candidate/sdpMLineIndex")
                        .and_then(Value::as_u64)
                        .unwrap_or(0) as u32;
                    let candidate = event
                        .body
                        .pointer("/candidate/candidate")
                        .and_then(Value::as_str)
                        .expect("sender ICE should contain a candidate");
                    receiver.emit_by_name::<()>("add-ice-candidate", &[&index, &candidate]);
                }
            }
            if video_buffers.load(AtomicOrdering::Relaxed) > 0
                && audio_buffers.load(AtomicOrdering::Relaxed) > 0
            {
                break;
            }
        }

        assert!(
            video_buffers.load(AtomicOrdering::Relaxed) > 0,
            "receiver should obtain encoded video RTP"
        );
        assert!(
            audio_buffers.load(AtomicOrdering::Relaxed) > 0,
            "receiver should obtain encoded audio RTP"
        );
        manager.stop_all();
        receiver.disconnect(pad_handler);
        let _ = receiver_pipeline.set_state(gst::State::Null);
    }

    #[tokio::test]
    #[ignore = "requires an interactive Windows process and the installed GStreamer runtime"]
    async fn media_pipeline_can_stop_before_the_phone_answers() {
        let process_id = std::env::var("BEZI_REMOTE_STREAM_TEST_PID")
            .expect("set BEZI_REMOTE_STREAM_TEST_PID to a visible application process")
            .parse::<u32>()
            .expect("BEZI_REMOTE_STREAM_TEST_PID must be a process ID");
        let manager =
            NativeMediaManager::new(Arc::new(ControlState::default())).expect("GStreamer init");
        let mut events = manager.subscribe();
        manager
            .start(
                "early-stop-device",
                &Uuid::new_v4().to_string(),
                process_id,
                None,
                StreamPreset::Balanced,
                &stream::probe(),
            )
            .expect("media pipeline should start");
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let event = events.recv().await.expect("media event channel closed");
                if event.message_type == "stream.offer" {
                    break;
                }
            }
        })
        .await
        .expect("media offer timed out");
        manager.stop_all();
    }
}
