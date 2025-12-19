use cpal::traits::{DeviceTrait, HostTrait};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioDevice {
    pub name: String,
    pub is_input: bool,
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioInfo {
    pub hosts: Vec<String>,
    pub devices: Vec<AudioDevice>,
    pub asio_available: bool,
    pub default_sample_rate: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)]
pub struct AudioStreamConfig {
    pub sample_rate: u32,
    pub channels: u16,
    pub buffer_size: u32,
}

impl Default for AudioStreamConfig {
    fn default() -> Self {
        Self {
            sample_rate: 48000,
            channels: 1,
            buffer_size: 480, // 10ms @ 48kHz
        }
    }
}

// 오디오 정보 가져오기
pub fn get_audio_info() -> AudioInfo {
    AudioInfo {
        hosts: list_audio_hosts(),
        devices: list_audio_devices(),
        asio_available: is_asio_available(),
        default_sample_rate: 48000,
    }
}

// 오디오 장치 목록
pub fn list_audio_devices() -> Vec<AudioDevice> {
    let mut devices = Vec::new();
    let host = cpal::default_host();
    
    if let Some(device) = host.default_input_device() {
        if let Ok(name) = device.name() {
            devices.push(AudioDevice {
                name: format!("[기본] {}", name),
                is_input: true,
                is_default: true,
            });
        }
    }
    
    if let Some(device) = host.default_output_device() {
        if let Ok(name) = device.name() {
            devices.push(AudioDevice {
                name: format!("[기본] {}", name),
                is_input: false,
                is_default: true,
            });
        }
    }
    
    if let Ok(input_devices) = host.input_devices() {
        for device in input_devices {
            if let Ok(name) = device.name() {
                if !devices.iter().any(|d| d.name.contains(&name) && d.is_input) {
                    devices.push(AudioDevice { name, is_input: true, is_default: false });
                }
            }
        }
    }
    
    if let Ok(output_devices) = host.output_devices() {
        for device in output_devices {
            if let Ok(name) = device.name() {
                if !devices.iter().any(|d| d.name.contains(&name) && !d.is_input) {
                    devices.push(AudioDevice { name, is_input: false, is_default: false });
                }
            }
        }
    }
    
    devices
}

// 오디오 호스트 목록
pub fn list_audio_hosts() -> Vec<String> {
    cpal::available_hosts()
        .iter()
        .map(|h| format!("{:?}", h))
        .collect()
}

// ASIO 사용 가능 여부
pub fn is_asio_available() -> bool {
    cpal::available_hosts()
        .iter()
        .any(|h| format!("{:?}", h).contains("Asio"))
}

// 기본 설정으로 오디오 테스트 (마이크 → 스피커 루프백)
pub fn test_audio_loopback() -> Result<String, String> {
    let host = cpal::default_host();
    
    let input_device = host.default_input_device()
        .ok_or("입력 장치 없음")?;
    let output_device = host.default_output_device()
        .ok_or("출력 장치 없음")?;
    
    let input_name = input_device.name().unwrap_or_default();
    let output_name = output_device.name().unwrap_or_default();
    
    // 지원되는 설정 확인
    let supported_config = input_device.default_input_config()
        .map_err(|e| format!("입력 설정 오류: {}", e))?;
    
    Ok(format!(
        "입력: {}\n출력: {}\n샘플레이트: {}Hz\n채널: {}",
        input_name,
        output_name,
        supported_config.sample_rate().0,
        supported_config.channels()
    ))
}

// 지원되는 샘플레이트 목록
pub fn get_supported_sample_rates(device_name: Option<String>, is_input: bool) -> Vec<u32> {
    let host = cpal::default_host();
    
    let device = if let Some(name) = device_name {
        if is_input {
            host.input_devices().ok()
                .and_then(|mut d| d.find(|dev| dev.name().map(|n| n.contains(&name)).unwrap_or(false)))
        } else {
            host.output_devices().ok()
                .and_then(|mut d| d.find(|dev| dev.name().map(|n| n.contains(&name)).unwrap_or(false)))
        }
    } else {
        if is_input { host.default_input_device() } else { host.default_output_device() }
    };
    
    let Some(device) = device else {
        return vec![48000];
    };
    
    // 기본 설정에서 샘플레이트 가져오기
    let config = if is_input {
        device.default_input_config()
    } else {
        device.default_output_config()
    };
    
    match config {
        Ok(c) => vec![c.sample_rate().0],
        Err(_) => vec![48000],
    }
}
