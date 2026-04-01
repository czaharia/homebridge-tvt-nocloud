import * as http from 'http';
import { parseStringPromise } from 'xml2js';

export interface DeviceInfo {
  model: string;
  brand: string;
  deviceDescription: string;
  softwareVersion: string;
  mac: string;
}

export interface AlarmStatus {
  channelId: number;
  motionDetected: boolean;
}

export class TVTApi {
  private readonly authHeader: string;

  constructor(
    private readonly host: string,
    private readonly port: number,
    username: string,
    password: string,
  ) {
    this.authHeader = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
  }

  private request(path: string, method: 'GET' | 'POST' = 'GET', body?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const options: http.RequestOptions = {
        hostname: this.host,
        port: this.port,
        path,
        method,
        headers: {
          Authorization: this.authHeader,
          Connection: 'close',
          ...(body
            ? { 'Content-Type': 'application/xml; charset="UTF-8"',
                'Content-Length': Buffer.byteLength(body) }
            : {}),
        },
      };
      const req = http.request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const rb = Buffer.concat(chunks).toString('utf-8');
          res.statusCode && res.statusCode >= 400
            ? reject(new Error(`TVT HTTP ${res.statusCode}: ${rb}`))
            : resolve(rb);
        });
      });
      req.setTimeout(10_000, () => { req.destroy(); reject(new Error('TVT API timeout')); });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  private async getXml(path: string): Promise<Record<string, unknown>> {
    const raw = await this.request(path);
    return parseStringPromise(raw, { explicitArray: false, ignoreAttrs: false }) as Promise<Record<string, unknown>>;
  }

  fetchBuffer(path: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { hostname: this.host, port: this.port, path, method: 'GET',
          headers: { Authorization: this.authHeader } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks)));
        });
      req.setTimeout(15_000, () => { req.destroy(); reject(new Error('Snapshot timeout')); });
      req.on('error', reject);
      req.end();
    });
  }

  async getDeviceInfo(): Promise<DeviceInfo> {
    const r = await this.getXml('/GetDeviceInfo');
    const i = ((r['config'] as Record<string, unknown>)?.['deviceInfo'] ?? {}) as Record<string, unknown>;
    const s = (k: string) => {
      const v = i[k];
      return typeof v === 'object' && v ? String((v as Record<string, unknown>)['_'] ?? '') : String(v ?? '');
    };
    return {
      model: s('model'), brand: s('brand'),
      deviceDescription: s('deviceDescription'),
      softwareVersion: s('softwareVersion'), mac: s('mac'),
    };
  }

  async getChannelList(): Promise<number[]> {
    try {
      const r = await this.getXml('/GetChannelList');
      const list = ((r['config'] as Record<string, unknown>)?.['channelIDList']) as Record<string, unknown> | undefined;
      if (!list) return [1];
      const items = list['item'];
      if (Array.isArray(items)) return items.map(i => parseInt(String(i), 10));
      if (items) return [parseInt(String(items), 10)];
      return [1];
    } catch { return [1]; }
  }

  async getAlarmStatus(): Promise<AlarmStatus[]> {
    try {
      const r  = await this.getXml('/GetAlarmStatus');
      const ml = (((r['config'] as Record<string, unknown>)?.['alarmStatus'] as Record<string, unknown>)
                    ?.['motionAlarm']) as Record<string, unknown>;
      const items = ml?.['item'];
      if (Array.isArray(items))
        return items.map((v: unknown, i) => ({ channelId: i + 1, motionDetected: String(v).trim() !== '0' }));
      if (items !== undefined)
        return [{ channelId: 1, motionDetected: String(items).trim() !== '0' }];
      return [];
    } catch { return []; }
  }

  async getSnapshot(channelId: number): Promise<Buffer> {
    try { return await this.fetchBuffer(`/GetSnapshot/${channelId}`); }
    catch  { return this.fetchBuffer(`/snap.jpg?JpegCam=${channelId}`); }
  }

  async setAlarmServerConfig(serverIp: string, serverPort: number): Promise<void> {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<config version="1.0">
  <alarmServer>
    <enable type="boolean">true</enable>
    <serverIP type="string"><![CDATA[${serverIp}]]></serverIP>
    <serverPort type="uint16">${serverPort}</serverPort>
    <urlPath type="string"><![CDATA[/motion]]></urlPath>
  </alarmServer>
</config>`;
    await this.request('/SetAlarmServerConfig', 'POST', xml);
  }
}