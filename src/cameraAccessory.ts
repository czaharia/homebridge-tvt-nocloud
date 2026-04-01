import type { API, Logger, PlatformAccessory, Service } from 'homebridge';
import { TVTStreamingDelegate, VideoConfig } from './streamingDelegate';
import { TVTApi } from './tvtApi';

export interface CameraConfig {
  channelId: number;
  name: string;
  motionDetection: boolean;
}

export type { VideoConfig };

/**
 * HomeKit accessory for a single TVT DVR channel.
 * Provides: live video streaming, snapshots, and an optional MotionSensor.
 */
export class TVTCameraAccessory {
  private motionSvc?: Service;
  private timer?: NodeJS.Timeout;

  constructor(
    private log: Logger,
    private api: API,
    acc: PlatformAccessory,
    tvtApi: TVTApi,
    private cfg: CameraConfig,
    vc: VideoConfig,
    host: string,
    rtspPort: number,
    _httpPort: number,
    username: string,
    password: string,
    useSubStream: boolean,
    ffmpeg: string,
    private motionTimeout: number,
  ) {
    const { Service: S, Characteristic: C } = api.hap;

    acc.getService(S.AccessoryInformation)!
      .setCharacteristic(C.Manufacturer,       'TVT Digital Technology')
      .setCharacteristic(C.Model,              'TVT DVR Camera')
      .setCharacteristic(C.SerialNumber,       `CH${cfg.channelId}`)
      .setCharacteristic(C.FirmwareRevision,   '1.0.0');

    const delegate = new TVTStreamingDelegate(
      log, api, tvtApi, cfg.channelId,
      host, rtspPort, username, password, vc, useSubStream, ffmpeg,
    );

    acc.configureController(new api.hap.CameraController({
      cameraStreamCount: 2,
      delegate,
      streamingOptions: {
        supportedCryptoSuites: [api.hap.SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
        video: {
          resolutions: [
            [1920, 1080, 30], [1280, 720, 30], [1280, 720, 15],
            [1024, 768,  30], [640,  480, 30], [640,  360, 30],
            [480,  360,  30], [320,  240, 30], [320,  240, 15],
          ],
          codec: {
            profiles: [
              api.hap.H264Profile.BASELINE,
              api.hap.H264Profile.MAIN,
              api.hap.H264Profile.HIGH,
            ],
            levels: [
              api.hap.H264Level.LEVEL3_1,
              api.hap.H264Level.LEVEL3_2,
              api.hap.H264Level.LEVEL4_0,
            ],
          },
        },
        audio: {
          twoWayAudio: false,
          codecs: [{
            type:         api.hap.AudioStreamingCodecType.AAC_ELD,
            samplerate:   api.hap.AudioStreamingSamplerate.KHZ_16,
            audioChannels: 1,
            bitrate:      api.hap.AudioBitrate.VARIABLE,
          }],
        },
      },
    }));

    if (cfg.motionDetection) {
      this.motionSvc = acc.getService(S.MotionSensor)
        ?? acc.addService(S.MotionSensor, `${cfg.name} Motion`);
      this.motionSvc.setCharacteristic(C.MotionDetected, false);
    }

    log.info(`Camera ready: ${cfg.name} (channel ${cfg.channelId})`);
  }

  triggerMotion(): void {
    if (!this.motionSvc) return;
    const C = this.api.hap.Characteristic;
    this.log.info(`Motion: ch${this.cfg.channelId} (${this.cfg.name})`);
    this.motionSvc.updateCharacteristic(C.MotionDetected, true);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(
      () => this.motionSvc!.updateCharacteristic(C.MotionDetected, false),
      this.motionTimeout * 1000,
    );
  }

  clearMotion(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    this.motionSvc?.updateCharacteristic(this.api.hap.Characteristic.MotionDetected, false);
  }

  get channelId() { return this.cfg.channelId; }
}