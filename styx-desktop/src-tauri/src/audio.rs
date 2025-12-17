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

// 오디오 정보 가져오기 (장치 목록, 호스트 등)
pub fn get_audio_info() -> AudioInfo {
    let hosts = list_audio_hosts();
    let devices = list_audio_devices();
    let asio_available = is_asio_available();
    
    AudioInfo {
        hosts,
        devices,
        asio_available,
        default_sample_rate: 48000,
    }
}

// 오디오 장치 목록 가져오기
pub fn list_audio_devices() -> Vec<AudioDevice> {
    let mut devices = Vec::new();
    let host = cpal::default_host();
    
    // 기본 입력 장치
    if let Some(device) = host.default_input_device() {
        if let Ok(name) = device.name() {
            devices.push(AudioDevice {
                name: format!("[기본] {}", name),
                is_input: true,
                is_default: true,
            });
        }
    }
    
    // 기본 출력 장치
    if let Some(device) = host.default_output_device() {
        if let Ok(name) = device.name() {
            devices.push(AudioDevice {
                name: format!("[기본] {}", name),
                is_input: false,
                is_default: true,
            });
        }
    }
    
    // 모든 입력 장치
    if let Ok(input_devices) = host.input_devices() {
        for device in input_devices {
            if let Ok(name) = device.name() {
                if !devices.iter().any(|d| d.name.contains(&name) && d.is_input) {
                    devices.push(AudioDevice {
                        name,
                        is_input: true,
                        is_default: false,
                    });
                }
            }
        }
    }
    
    // 모든 출력 장치
    if let Ok(output_devices) = host.output_devices() {
        for device in output_devices {
            if let Ok(name) = device.name() {
                if !devices.iter().any(|d| d.name.contains(&name) && !d.is_input) {
                    devices.push(AudioDevice {
                        name,
                        is_input: false,
                        is_default: false,
                    });
                }
            }
        }
    }
    
    devices
}

// 사용 가능한 오디오 호스트 목록
pub fn list_audio_hosts() -> Vec<String> {
    cpal::available_hosts()
        .iter()
        .map(|h| format!("{:?}", h))
        .collect()
}

// ASIO 사용 가능 여부 확인
pub fn is_asio_available() -> bool {
    cpal::available_hosts()
        .iter()
        .any(|h| format!("{:?}", h).contains("Asio"))
}
