// 오디오 스트리밍 모듈 - UDP 전송용
#![allow(dead_code)]
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::SampleFormat;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::mpsc;

// 오디오 스트림 상태
pub struct StreamState {
    pub is_running: Arc<AtomicBool>,
    pub is_muted: Arc<AtomicBool>,
    pub sample_rate: u32,
    pub channels: u16,
}

impl Default for StreamState {
    fn default() -> Self {
        Self {
            is_running: Arc::new(AtomicBool::new(false)),
            is_muted: Arc::new(AtomicBool::new(false)),
            sample_rate: 48000,
            channels: 1,
        }
    }
}

// 오디오 캡처 시작 (마이크 → 채널로 전송)
pub fn start_audio_capture(
    tx: mpsc::Sender<Vec<f32>>,
    is_running: Arc<AtomicBool>,
    is_muted: Arc<AtomicBool>,
) -> Result<(), String> {
    let host = cpal::default_host();
    let device = host.default_input_device()
        .ok_or("입력 장치 없음")?;
    
    let config = device.default_input_config()
        .map_err(|e| format!("입력 설정 오류: {}", e))?;
    
    let sample_format = config.sample_format();
    let config = config.into();
    
    is_running.store(true, Ordering::SeqCst);
    let is_running_clone = is_running.clone();
    let is_muted_clone = is_muted.clone();
    
    std::thread::spawn(move || {
        let stream = match sample_format {
            SampleFormat::F32 => device.build_input_stream(
                &config,
                move |data: &[f32], _| {
                    if !is_muted_clone.load(Ordering::Relaxed) && is_running_clone.load(Ordering::Relaxed) {
                        let _ = tx.blocking_send(data.to_vec());
                    }
                },
                |err| eprintln!("입력 스트림 오류: {}", err),
                None,
            ),
            SampleFormat::I16 => device.build_input_stream(
                &config,
                move |data: &[i16], _| {
                    if !is_muted_clone.load(Ordering::Relaxed) && is_running_clone.load(Ordering::Relaxed) {
                        let floats: Vec<f32> = data.iter().map(|&s| s as f32 / 32768.0).collect();
                        let _ = tx.blocking_send(floats);
                    }
                },
                |err| eprintln!("입력 스트림 오류: {}", err),
                None,
            ),
            _ => return,
        };
        
        if let Ok(stream) = stream {
            let _ = stream.play();
            while is_running.load(Ordering::Relaxed) {
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
        }
    });
    
    Ok(())
}

// 오디오 재생 (채널에서 받아서 → 스피커)
pub fn start_audio_playback(
    mut rx: mpsc::Receiver<Vec<f32>>,
    is_running: Arc<AtomicBool>,
) -> Result<(), String> {
    let host = cpal::default_host();
    let device = host.default_output_device()
        .ok_or("출력 장치 없음")?;
    
    let config = device.default_output_config()
        .map_err(|e| format!("출력 설정 오류: {}", e))?;
    
    let sample_format = config.sample_format();
    let config = config.into();
    
    let buffer = Arc::new(std::sync::Mutex::new(Vec::<f32>::new()));
    let buffer_clone = buffer.clone();
    
    std::thread::spawn(move || {
        // 버퍼 채우기 스레드
        let buffer_fill = buffer_clone.clone();
        std::thread::spawn(move || {
            while let Some(data) = rx.blocking_recv() {
                if let Ok(mut buf) = buffer_fill.lock() {
                    buf.extend(data);
                    // 버퍼 크기 제한 (100ms @ 48kHz)
                    let len = buf.len();
                    if len > 4800 {
                        buf.drain(0..len - 4800);
                    }
                }
            }
        });
        
        let stream = match sample_format {
            SampleFormat::F32 => device.build_output_stream(
                &config,
                move |data: &mut [f32], _| {
                    if let Ok(mut buf) = buffer_clone.lock() {
                        for sample in data.iter_mut() {
                            *sample = buf.pop().unwrap_or(0.0);
                        }
                    }
                },
                |err| eprintln!("출력 스트림 오류: {}", err),
                None,
            ),
            _ => return,
        };
        
        if let Ok(stream) = stream {
            let _ = stream.play();
            while is_running.load(Ordering::Relaxed) {
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
        }
    });
    
    Ok(())
}

// f32 샘플을 바이트로 변환
pub fn samples_to_bytes(samples: &[f32]) -> Vec<u8> {
    samples.iter()
        .flat_map(|&s| s.to_le_bytes())
        .collect()
}

// 바이트를 f32 샘플로 변환
pub fn bytes_to_samples(bytes: &[u8]) -> Vec<f32> {
    bytes.chunks_exact(4)
        .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .collect()
}
