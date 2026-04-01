import * as http from 'http';
import * as url  from 'url';
import * as os   from 'os';
import { execSync } from 'child_process';
import type { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig } from 'homebridge';
import { TVTApi } from './tvtApi';
import { TVTCameraAccessory, CameraConfig, VideoConfig } from './cameraAccessory';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';

interface TVTConfig extends PlatformConfig {
  host: string;
  httpPort?: number;
  rtspPort?: number;
  username?: string;
  password?: string;
  channelCount?: number;
  motionDetection?: boolean;
  motionHttpPort?: number;
  motionPollingInterval?: number;
  motionTimeout?: number;
  useSubStream?: boolean;
  ffmpegPath?: string;
  videoConfig?: Partial<VideoConfig>;
  cameras?: Array<{ channelId: number; name?: string; motionDetection?: boolean }>;
}

export class TVTPlatform implements DynamicPlatformPlugin {
  private cached  = new Map<string, PlatformAccessory>();
  private cameras = new Map<number, TVTCameraAccessory>();
  private tvtApi: TVTApi;
  private cfg: TVTConfig;
  private vc: VideoConfig;
  private motionSrv?: http.Server;
  private pollTimer?: NodeJS.Timeout;

  constructor(
    private log: Logger,
    config: PlatformConfig,
    private api: API,
  ) {
    this.cfg = config as TVTConfig;
    if (!this.cfg.host) this.log.error('"host" is required in config');

    this.vc = {
      maxWidth:       this.cfg.videoConfig?.maxWidth       ?? 1920,
      maxHeight:      this.cfg.videoConfig?.maxHeight      ?? 1080,
      maxFPS:         this.cfg.videoConfig?.maxFPS         ?? 15,
      maxBitrate:     this.cfg.videoConfig?.maxBitrate     ?? 1500,
      packetSize:     this.cfg.videoConfig?.packetSize     ?? 1316,
      encoderOptions: this.cfg.videoConfig?.encoderOptions,
      forceMax:       this.cfg.videoConfig?.forceMax       ?? false,
    };

    this.tvtApi = new TVTApi(
      this.cfg.host,
      this.cfg.httpPort   ?? 80,
      this.cfg.username   ?? 'admin',
      this.cfg.password   ?? '',
    );

    this.api.on('didFinishLaunching', () => this.init());
    this.api.on('shutdown', () => {
      this.motionSrv?.close();
      if (this.pollTimer) clearInterval(this.pollTimer);
    });
  }

  configureAccessory(acc: PlatformAccessory): void {
    this.cached.set(acc.UUID, acc);
  }

  private async init(): Promise<void> {
    if (!this.cfg.host) return;

    const ffmpeg = this.findFfmpeg();
    this.log.info(`FFmpeg: ${ffmpeg}`);

    try {
      const d = await this.tvtApi.getDeviceInfo();
      this.log.info(`DVR: ${d.brand} ${d.model}  FW:${d.softwareVersion}  MAC:${d.mac}`);
    } catch (e) { this.log.warn(`Device info unavailable: ${e}`); }

    // Channel discovery
    let channels: number[];
    if (this.cfg.channelCount) {
      channels = Array.from({ length: this.cfg.channelCount }, (_, i) => i + 1);
      this.log.info(`Using configured channelCount=${this.cfg.channelCount}`);
    } else {
      try {
        channels = await this.tvtApi.getChannelList();
        this.log.info(`Auto-discovered channels: [${channels.join(', ')}]`);
      } catch (e) {
        this.log.warn(`Channel discovery failed (${e}) — defaulting to ch1`);
        channels = [1];
      }
    }

    const active = new Set<string>();

    for (const chId of channels) {
      const ov  = this.cfg.cameras?.find(c => c.channelId === chId);
      const cam: CameraConfig = {
        channelId: chId,
        name: ov?.name ?? `Camera ${chId}`,
        motionDetection: ov?.motionDetection ?? (this.cfg.motionDetection !== false),
      };

      const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${this.cfg.host}:${chId}`);
      active.add(uuid);

      let acc = this.cached.get(uuid);
      if (!acc) {
        this.log.info(`Registering new camera: ${cam.name}`);
        acc = new this.api.platformAccessory(cam.name, uuid, this.api.hap.Categories.CAMERA);
        this.cached.set(uuid, acc);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
      } else {
        acc.displayName = cam.name;
        this.api.updatePlatformAccessories([acc]);
      }

      this.cameras.set(chId, new TVTCameraAccessory(
        this.log, this.api, acc, this.tvtApi, cam, this.vc,
        this.cfg.host, this.cfg.rtspPort ?? 554, this.cfg.httpPort ?? 80,
        this.cfg.username ?? 'admin', this.cfg.password ?? '',
        this.cfg.useSubStream ?? false, ffmpeg, this.cfg.motionTimeout ?? 30,
      ));
    }

    for (const [uuid, acc] of this.cached) {
      if (!active.has(uuid)) {
        this.log.info(`Removing stale accessory: ${acc.displayName}`);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
        this.cached.delete(uuid);
      }
    }

    if (this.cfg.motionDetection !== false)
      this.startMotionSrv(this.cfg.motionHttpPort ?? 10888);

    const poll = this.cfg.motionPollingInterval ?? 0;
    if (poll > 0) {
      this.log.info(`Motion polling every ${poll}s`);
      this.pollTimer = setInterval(() => this.poll(), poll * 1000);
    }

    this.log.info('TVT platform ready.');
  }

  private startMotionSrv(port: number): void {
    this.motionSrv = http.createServer((req, res) => {
      const p  = url.parse(req.url ?? '/', true);
      const qs = p.query as Record<string, string>;
      const mch = (p.pathname ?? '').match(/\/(?:motion|alarm)\/(\d+)/);
      let ch = mch ? parseInt(mch[1], 10) : 0;
      let body = '';

      req.on('data', (d: Buffer) => { body += d.toString(); });
      req.on('end', () => {
        if (!ch) {
          const m = body.match(/<(?:channelId|channel|chn|chID)[^>]*>(\d+)</);
          if (m) ch = parseInt(m[1], 10);
        }
        if (!ch) {
          ch = parseInt(qs['channel'] ?? qs['chn'] ?? qs['ch'] ?? qs['id'] ?? '0', 10) || 0;
        }

        this.log.debug(`Motion push: ch=${ch || 'all'}  path=${p.pathname}`);
        ch ? this.fire(ch) : this.cameras.forEach(c => this.fire(c.channelId));

        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('OK');
      });
    });

    this.motionSrv.on('error', e => this.log.error(`Motion server: ${e.message}`));
    this.motionSrv.listen(port, '0.0.0.0', () => {
      const ip = this.localIp();
      this.log.info(`Motion push listening → http://${ip}:${port}/motion`);
      this.log.info(`  Set this in DVR: Alarm > Motion > HTTP Notification`);
    });
  }

  private async poll(): Promise<void> {
    try {
      const statuses = await this.tvtApi.getAlarmStatus();
      statuses.filter(s => s.motionDetected).forEach(s => this.fire(s.channelId));
    } catch (e) { this.log.debug(`Poll error: ${e}`); }
  }

  private fire(ch: number): void {
    this.cameras.get(ch)?.triggerMotion();
  }

  private findFfmpeg(): string {
    if (this.cfg.ffmpegPath) return this.cfg.ffmpegPath;
    try { return require('ffmpeg-for-homebridge') as string; } catch { /* */ }
    try {
      const p = execSync('which ffmpeg', { encoding: 'utf-8' }).trim().split('\n')[0];
      if (p) return p;
    } catch { /* */ }
    this.log.warn('ffmpeg not found — install ffmpeg-for-homebridge or set ffmpegPath in config');
    return 'ffmpeg';
  }

  private localIp(): string {
    for (const iface of Object.values(os.networkInterfaces()))
      for (const n of (iface ?? []))
        if (!n.internal && n.family === 'IPv4') return n.address;
    return '127.0.0.1';
  }
}