import { ChildProcess, spawn } from 'child_process';
import * as os from 'os';
import { EventEmitter } from 'events';
import type {
  API, Logger, CameraStreamingDelegate,
  PrepareStreamCallback, PrepareStreamRequest, PrepareStreamResponse,
  StreamRequestCallback, StreamingRequest,
  SnapshotRequest, SnapshotRequestCallback,
} from 'homebridge';
import { TVTApi } from './tvtApi';

export interface VideoConfig {
  maxWidth: number;
  maxHeight: number;
  maxFPS: number;
  maxBitrate: number;
  packetSize: number;
  encoderOptions?: string;
  forceMax?: boolean;
}

interface Session {
  proc?: ChildProcess;
  localPort: number;
  targetAddress: string;
  targetVideoPort: number;
  targetVideoSrtpKey: Buffer;
  targetVideoSrtpSalt: Buffer;
  videoSSRC: number;
  localVideoSrtpKey: Buffer;
  localVideoSrtpSalt: Buffer;
}

export class TVTStreamingDelegate extends EventEmitter implements CameraStreamingDelegate {
  private sessions = new Map<string, Session>();

  constructor(
    private log: Logger,
    private api: API,
    private tvtApi: TVTApi,
    private channelId: number,
    private host: string,
    private rtspPort: number,
    private username: string,
    private password: string,
    private vc: VideoConfig,
    private useSubStream: boolean,
    private ffmpeg: string,
  ) { super(); }

  async handleSnapshotRequest(req: SnapshotRequest, cb: SnapshotRequestCallback): Promise<void> {
    this.log.debug(`[Ch${this.channelId}] Snapshot ${req.width}×${req.height}`);
    try { cb(undefined, await this.tvtApi.getSnapshot(this.channelId)); }
    catch (e) { this.log.error(`[Ch${this.channelId}] Snapshot failed: ${e}`); cb(new Error(String(e))); }
  }

  async prepareStream(req: PrepareStreamRequest, cb: PrepareStreamCallback): Promise<void> {
    this.log.debug("Reporting local IP to HomeKit:", this.localAddr(req.targetAddress));
	const id        = req.sessionID;
    const localPort = await this.allocPort();
    const videoSSRC = this.ssrc();
 
    const { randomFillSync } = await import('crypto');
    const our_key  = Buffer.alloc(16); 
    randomFillSync(our_key);
    const our_salt = Buffer.alloc(14); 
    randomFillSync(our_salt);
    
    this.sessions.set(id, {
      localPort,
      targetAddress:       req.targetAddress,
      targetVideoPort:     req.video.port,
      targetVideoSrtpKey:  req.video.srtp_key,
      targetVideoSrtpSalt: req.video.srtp_salt,
      localVideoSrtpKey:   our_key,   // Fixed: variable now exists
      localVideoSrtpSalt:  our_salt,  // Fixed: variable now exists
      videoSSRC,
    });
    
    const resp: PrepareStreamResponse = {
      address: this.localAddr(req.targetAddress),
      video: {
        port:      localPort,
        ssrc:      videoSSRC,
        srtp_key:  our_key,
        srtp_salt: our_salt,
      },
      audio: {
        port:      localPort + 2,
        ssrc:      this.ssrc(),
        srtp_key:  Buffer.alloc(16, 0),
        srtp_salt: Buffer.alloc(14, 0),
      },
    };
    cb(undefined, resp);
  }

  async handleStreamRequest(req: StreamingRequest, cb: StreamRequestCallback): Promise<void> {
    const id = req.sessionID;
  
    const type = (req as unknown as { type: string }).type;
  
    if (type === 'stop') { this.stop(id); cb(); return; }
    if (type === 'reconfigure') { cb(); return; }
  
    const s = this.sessions.get(id);
    if (!s) { cb(new Error('Unknown session')); return; }
  
    const startReq = req as any;
    const v        = startReq.video;
  
    const W       = this.vc.forceMax ? this.vc.maxWidth  : (v.width  || this.vc.maxWidth);
    const H       = this.vc.forceMax ? this.vc.maxHeight : (v.height || this.vc.maxHeight);
    const fps     = Math.min(v.fps || this.vc.maxFPS, this.vc.maxFPS);
    const bitrate = Math.min(v.max_bit_rate || this.vc.maxBitrate, this.vc.maxBitrate);
    const mtu     = v.mtu || this.vc.packetSize;
    const pt      = v.pt  ?? 99;
  
	const srtpB64 = Buffer.concat([s.localVideoSrtpKey, s.localVideoSrtpSalt]).toString('base64');
    const streamT  = this.useSubStream ? 'sub' : 'main';
    const rtspUrl  = `rtsp://${encodeURIComponent(this.username)}:${encodeURIComponent(this.password)}`
                   + `@${this.host}:${this.rtspPort}/?chID=${this.channelId}&streamType=${streamT}&linkType=tcp`;
	const args = [
	  '-hide_banner',
	  '-fflags', 'nobuffer+genpts',
	  '-flags', 'low_delay',
	  '-rtsp_transport', 'tcp',
	  '-i', rtspUrl,
	  '-an', '-sn', '-dn',
	  '-vcodec', 'copy',
	  '-payload_type', String(pt),
	  '-ssrc', String(s.videoSSRC),
	  '-f', 'rtp',
	  '-srtp_out_suite', 'AES_CM_128_HMAC_SHA1_80',
	  '-srtp_out_params', srtpB64,
	  `srtp://${s.targetAddress}:${s.targetVideoPort}?rtcpport=${s.targetVideoPort}&pkt_size=${mtu}`,
	  '-loglevel', 'debug'
	];
 
    this.log.debug(`[Ch${this.channelId}] Launching FFmpeg...`);
    this.log.debug(`  ${this.ffmpeg} ${args.join(' ')}`);
  
    const proc = spawn(this.ffmpeg, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    s.proc = proc;
  
    proc.stderr?.on('data', (d: Buffer) => {
      const l = d.toString().trim();
      if (l) this.log.debug(`[FFmpeg ch${this.channelId}] ${l}`);
    });
    proc.on('error', e => this.log.error(`[Ch${this.channelId}] FFmpeg error: ${e.message}`));
    proc.on('exit', (code, sig) => {
      if (code !== 0 && sig !== 'SIGTERM')
        this.log.warn(`[Ch${this.channelId}] FFmpeg exited: code=${code} signal=${sig}`);
      this.sessions.delete(id);
    });
  
    cb();
  }
  
    private stop(id: string): void {
      const s = this.sessions.get(id);
      s?.proc?.kill('SIGTERM');
      this.sessions.delete(id);
    }
  
    private ssrc(): number { return Math.floor(Math.random() * 0x7fffffff); }
  
    private localAddr(target: string): string {
      const v6 = target.includes(':');
      for (const iface of Object.values(os.networkInterfaces()))
        for (const n of (iface ?? []))
          if (!n.internal && (v6 ? n.family === 'IPv6' : n.family === 'IPv4')) return n.address;
      return v6 ? '::1' : '127.0.0.1';
    }
  
    private allocPort(lo = 10000, hi = 64000): Promise<number> {
      return new Promise((res, rej) => {
        const net = require('net') as typeof import('net');
        const p   = Math.floor(Math.random() * (hi - lo)) + lo;
        const srv = net.createServer();
        srv.listen(p, '0.0.0.0', () => srv.close(() => res(p)));
        srv.on('error', () => this.allocPort(lo, hi).then(res, rej));
      });
    }
  }