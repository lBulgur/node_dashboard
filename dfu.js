// Nordic Secure DFU over Web Bluetooth
// Für Adafruit nRF52 Bootloader (Seeed XIAO nRF52840)

const DFU_SERVICE_UUID = '0000fe59-0000-1000-8000-00805f9b34fb';
const DFU_CONTROL_UUID = '8ec90001-f315-4f60-9fb8-838830daea50';
const DFU_PACKET_UUID  = '8ec90002-f315-4f60-9fb8-838830daea50';

class NordicDfu {
    constructor(onProgress, onStatus) {
        this.onProgress = onProgress || (() => {});
        this.onStatus = onStatus || (() => {});
        this.controlChar = null;
        this.packetChar = null;
        this.notifyResolve = null;
        this.notifyReject = null;
    }

    async performUpdate(zipArrayBuffer) {
        const { initPacket, firmware } = await this.parseZip(zipArrayBuffer);
        this.onStatus(`Firmware: ${firmware.byteLength} Bytes`);

        this.onStatus('Suche DFU-Bootloader...');
        const device = await navigator.bluetooth.requestDevice({
            filters: [
                { services: [DFU_SERVICE_UUID] },
                { namePrefix: 'DfuTarg' },
                { namePrefix: 'Adafruit' },
                { namePrefix: 'XIAO' } // <--- NEU für den oltaco Bootloader
            ],
            optionalServices: [DFU_SERVICE_UUID]
        });

        this.onStatus('Verbinde...');
        const server = await device.gatt.connect();
        const service = await server.getPrimaryService(DFU_SERVICE_UUID);

        this.controlChar = await service.getCharacteristic(DFU_CONTROL_UUID);
        this.packetChar = await service.getCharacteristic(DFU_PACKET_UUID);

        await this.controlChar.startNotifications();
        this.controlChar.addEventListener('characteristicvaluechanged', (ev) => {
            const dv = new DataView(ev.target.value.buffer);
            if (this.notifyResolve) {
                const resolve = this.notifyResolve;
                const reject = this.notifyReject;
                this.notifyResolve = null;
                this.notifyReject = null;
                if (dv.getUint8(0) === 0x60 && dv.getUint8(2) === 0x01) {
                    resolve(dv);
                } else {
                    reject(new Error(`DFU Fehler: op=0x${dv.getUint8(1).toString(16)} res=0x${dv.getUint8(2).toString(16)}`));
                }
            }
        });

        try {
            // PRN deaktivieren
            await this.writeControl(0x02, [0x00, 0x00]);

            // Init-Paket senden (Command Object)
            this.onStatus('Init-Paket...');
            await this.transferObject(0x01, new Uint8Array(initPacket), false);

            // Firmware senden (Data Object)
            this.onStatus('Firmware wird übertragen...');
            await this.transferObject(0x02, new Uint8Array(firmware), true);

            this.onStatus('Update erfolgreich! Node startet neu...');
        } finally {
            try { server.disconnect(); } catch(e) {}
        }
    }

    async transferObject(type, data, showProgress) {
        // SELECT: max. Objektgröße abfragen
        const sel = await this.writeControl(0x06, [type]);
        const maxSize = sel.getUint32(3, true);

        let offset = 0;
        const total = data.byteLength;

        while (offset < total) {
            const objSize = Math.min(maxSize, total - offset);

            // CREATE
            await this.writeControl(0x01, [type, ...this.u32(objSize)]);

            // Daten in BLE-Chunks schreiben
            const objData = data.slice(offset, offset + objSize);
            const chunkSize = 200;

            for (let i = 0; i < objData.byteLength; i += chunkSize) {
                const end = Math.min(i + chunkSize, objData.byteLength);
                await this.packetChar.writeValueWithoutResponse(objData.slice(i, end));
            }

            // CRC prüfen
            const crcResp = await this.writeControl(0x03, []);
            const respCrc = crcResp.getUint32(7, true);
            const expectedCrc = this.crc32(data.slice(0, offset + objSize));
            if (respCrc !== expectedCrc) {
                throw new Error(`CRC Fehler bei Offset ${offset + objSize}`);
            }

            // EXECUTE
            await this.writeControl(0x04, []);

            offset += objSize;
            if (showProgress) {
                this.onProgress(Math.round(offset / total * 100));
            }
        }
    }

    writeControl(opcode, params) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.notifyResolve = null;
                this.notifyReject = null;
                reject(new Error('DFU Timeout'));
            }, 15000);

            this.notifyResolve = (dv) => { clearTimeout(timeout); resolve(dv); };
            this.notifyReject = (err) => { clearTimeout(timeout); reject(err); };

            this.controlChar.writeValueWithResponse(new Uint8Array([opcode, ...params]))
                .catch((err) => { clearTimeout(timeout); reject(err); });
        });
    }

    u32(val) {
        const b = new Uint8Array(4);
        new DataView(b.buffer).setUint32(0, val, true);
        return [...b];
    }

    // CRC32 (identisch mit Nordic DFU Protokoll)
    crc32(data) {
        if (!NordicDfu._crcTable) {
            const t = new Uint32Array(256);
            for (let i = 0; i < 256; i++) {
                let c = i;
                for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
                t[i] = c;
            }
            NordicDfu._crcTable = t;
        }
        const bytes = new Uint8Array(data);
        let crc = 0xFFFFFFFF;
        for (let i = 0; i < bytes.length; i++) {
            crc = NordicDfu._crcTable[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
        }
        return (crc ^ 0xFFFFFFFF) >>> 0;
    }

    // Minimaler ZIP-Parser mit Deflate-Support (kein JSZip nötig → offline-fähig)
    async parseZip(buffer) {
        const view = new DataView(buffer);
        const entries = [];

        let offset = 0;
        while (offset < buffer.byteLength - 4) {
            const sig = view.getUint32(offset, true);
            if (sig !== 0x04034b50) break;

            const compMethod = view.getUint16(offset + 8, true);
            const compSize = view.getUint32(offset + 18, true);
            const nameLen = view.getUint16(offset + 26, true);
            const extraLen = view.getUint16(offset + 28, true);
            const name = new TextDecoder().decode(new Uint8Array(buffer, offset + 30, nameLen));
            const dataStart = offset + 30 + nameLen + extraLen;
            const rawData = buffer.slice(dataStart, dataStart + compSize);

            entries.push({ name, compMethod, rawData });
            offset = dataStart + compSize;
        }

        // Dateien entpacken (stored oder deflate)
        const files = {};
        for (const entry of entries) {
            if (entry.compMethod === 0) {
                files[entry.name] = entry.rawData;
            } else if (entry.compMethod === 8) {
                files[entry.name] = await this.inflateRaw(entry.rawData);
            } else {
                throw new Error(`Unbekannte Komprimierung (${entry.compMethod}) in ${entry.name}`);
            }
        }

        // manifest.json lesen
        const manifestBuf = files['manifest.json'];
        if (!manifestBuf) throw new Error('Kein manifest.json in ZIP gefunden');
        const manifest = JSON.parse(new TextDecoder().decode(new Uint8Array(manifestBuf)));
        const app = manifest.manifest.application;

        const initPacket = files[app.dat_file];
        const firmware = files[app.bin_file];
        if (!initPacket || !firmware) {
            throw new Error(`Firmware-Dateien nicht gefunden: ${app.dat_file}, ${app.bin_file}`);
        }

        return { initPacket, firmware };
    }

    async inflateRaw(compressedBuffer) {
        const ds = new DecompressionStream('deflate-raw');
        const writer = ds.writable.getWriter();
        const reader = ds.readable.getReader();

        writer.write(new Uint8Array(compressedBuffer));
        writer.close();

        const chunks = [];
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
        }

        const totalLen = chunks.reduce((sum, c) => sum + c.byteLength, 0);
        const result = new Uint8Array(totalLen);
        let pos = 0;
        for (const chunk of chunks) {
            result.set(chunk, pos);
            pos += chunk.byteLength;
        }
        return result.buffer;
    }
}
