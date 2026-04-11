import { REG_EAX, REG_EBX, REG_ECX, REG_EDX, LOG_OTHER } from "./const.js";
import { dbg_log } from "./log.js";

// For Types Only
import { CPU } from "./cpu.js";
import { BusConnector } from "./bus.js";

const VMWARE_PORT = 0x5658;
const VMWARE_MAGIC = 0x564D5868;

const CMD_GETSELLENGTH = 6;
const CMD_GETNEXTPIECE = 7;
const CMD_SETSELLENGTH = 8;
const CMD_SETNEXTPIECE = 9;
const CMD_GETVERSION = 10;
const CMD_ABSPOINTER_DATA = 39;
const CMD_ABSPOINTER_STATUS = 40;
const CMD_ABSPOINTER_COMMAND = 41;

const ABSPOINTER_ENABLE = 0x45414552;
const ABSPOINTER_DISABLE = 0x000000F5;
const ABSPOINTER_RELATIVE = 0x4C455252;
const ABSPOINTER_ABSOLUTE = 0x53424152;

const READ_ID = 0x3442554A;

const BUTTON_LEFT = 0x20;
const BUTTON_RIGHT = 0x10;
const BUTTON_MIDDLE = 0x08;

const QUEUE_MAX = 1024;
const CLIP_MAX = 0x10000;

/**
 * VMware backdoor (port 0x5658). Implements the absolute-pointer commands so
 * a guest driver can track the host cursor 1:1 without pointer lock, plus the
 * legacy text-clipboard commands (6–9) so a guest agent can sync CF_TEXT with
 * the host. PS/2 still supplies the mouse IRQ; the driver reads this port on
 * each IRQ12.
 *
 * @constructor
 * @param {CPU} cpu
 * @param {BusConnector} bus
 */
export function VMwareMouse(cpu, bus)
{
    /** @const @type {CPU} */
    this.cpu = cpu;

    /** @const @type {BusConnector} */
    this.bus = bus;

    /** @type {boolean} */
    this.enabled = false;

    /** @type {boolean} */
    this.absolute = false;

    /** @type {!Array<number>} */
    this.queue = [];

    this.buttons = 0;
    this.last_x = -1;
    this.last_y = -1;
    this.tail_is_move = false;

    /** @type {Uint8Array} host→guest text staged for the guest to read */
    this.clip_out = new Uint8Array(0);
    this.clip_out_cursor = 0;
    this.clip_out_fresh = false;

    /** @type {Uint8Array} guest→host text being received */
    this.clip_in = new Uint8Array(0);
    this.clip_in_cursor = 0;

    this.bus.register("vmware-clipboard-host", function(data)
    {
        this.clip_out = data.length > CLIP_MAX ? data.subarray(0, CLIP_MAX) : data;
        this.clip_out_cursor = 0;
        this.clip_out_fresh = true;
    }, this);

    this.bus.register("mouse-absolute", function(data)
    {
        const x = Math.max(0, Math.min(0xFFFF, Math.round(data[0] / data[2] * 0xFFFF)));
        const y = Math.max(0, Math.min(0xFFFF, Math.round(data[1] / data[3] * 0xFFFF)));
        if(x === this.last_x && y === this.last_y)
        {
            return;
        }
        this.last_x = x;
        this.last_y = y;
        this.push_packet(0, true);
    }, this);

    this.bus.register("mouse-click", function(data)
    {
        this.buttons =
            (data[0] ? BUTTON_LEFT : 0) |
            (data[1] ? BUTTON_MIDDLE : 0) |
            (data[2] ? BUTTON_RIGHT : 0);
        this.push_packet(0, false);
    }, this);

    this.bus.register("mouse-wheel", function(data)
    {
        this.push_packet(-data[0] | 0, false);
    }, this);

    cpu.io.register_read(VMWARE_PORT, this, undefined, undefined, this.port_read32);
    cpu.io.register_write(VMWARE_PORT, this, undefined, undefined, this.port_write32);
}

VMwareMouse.prototype.push_packet = function(wheel, move_only)
{
    if(!this.enabled || !this.absolute || this.last_x < 0)
    {
        return;
    }
    // Absolute pointing has no use for move history — if the guest hasn't
    // drained the previous move yet, overwrite it in place. Clicks and wheel
    // are never coalesced. This keeps the guest cursor at most one frame
    // behind regardless of how slowly it drains, and makes overflow
    // unreachable in practice.
    if(move_only && this.tail_is_move && this.queue.length >= 4)
    {
        this.queue[this.queue.length - 3] = this.last_x;
        this.queue[this.queue.length - 2] = this.last_y;
        return;
    }
    if(this.queue.length + 4 > QUEUE_MAX)
    {
        this.enabled = false;
        this.queue.length = 0;
        dbg_log("vmware mouse: queue overflow, disabling", LOG_OTHER);
        return;
    }
    this.queue.push(this.buttons, this.last_x, this.last_y, wheel);
    this.tail_is_move = move_only;
};

VMwareMouse.prototype.port_read32 = function()
{
    const reg32 = this.cpu.reg32;
    if((reg32[REG_EAX] | 0) !== (VMWARE_MAGIC | 0))
    {
        return 0xFFFFFFFF | 0;
    }

    switch(reg32[REG_ECX] & 0xFFFF)
    {
        case CMD_GETVERSION:
            reg32[REG_EBX] = VMWARE_MAGIC;
            return 6;

        case CMD_GETSELLENGTH:
            if(!this.clip_out_fresh)
            {
                return 0xFFFFFFFF | 0;
            }
            this.clip_out_fresh = false;
            this.clip_out_cursor = 0;
            return this.clip_out.length;

        case CMD_GETNEXTPIECE:
        {
            const c = this.clip_out;
            let i = this.clip_out_cursor;
            const v = (c[i] | 0) | (c[i + 1] | 0) << 8 |
                      (c[i + 2] | 0) << 16 | (c[i + 3] | 0) << 24;
            this.clip_out_cursor = i + 4;
            return v;
        }

        case CMD_SETSELLENGTH:
        {
            const n = Math.min(reg32[REG_EBX] >>> 0, CLIP_MAX);
            this.clip_in = new Uint8Array(n);
            this.clip_in_cursor = 0;
            if(n === 0)
            {
                this.bus.send("vmware-clipboard-guest", this.clip_in);
            }
            return 0;
        }

        case CMD_SETNEXTPIECE:
        {
            const c = this.clip_in;
            const v = reg32[REG_EBX] >>> 0;
            let i = this.clip_in_cursor;
            if(i < c.length) c[i++] = v;
            if(i < c.length) c[i++] = v >>> 8;
            if(i < c.length) c[i++] = v >>> 16;
            if(i < c.length) c[i++] = v >>> 24;
            this.clip_in_cursor = i;
            if(i >= c.length)
            {
                this.bus.send("vmware-clipboard-guest", c);
                this.clip_in = new Uint8Array(0);
                this.clip_in_cursor = 0;
            }
            return 0;
        }

        case CMD_ABSPOINTER_STATUS:
            return this.enabled ? this.queue.length : 0xFFFF0000 | 0;

        case CMD_ABSPOINTER_DATA:
        {
            const n = Math.min(reg32[REG_EBX] >>> 0, 4, this.queue.length);
            const v = [0, 0, 0, 0];
            for(let i = 0; i < n; i++)
            {
                v[i] = this.queue.shift();
            }
            reg32[REG_EBX] = v[1];
            reg32[REG_ECX] = v[2];
            reg32[REG_EDX] = v[3];
            return v[0];
        }

        case CMD_ABSPOINTER_COMMAND:
            switch(reg32[REG_EBX] | 0)
            {
                case ABSPOINTER_ENABLE | 0:
                    this.enabled = true;
                    this.queue.length = 0;
                    this.tail_is_move = false;
                    this.queue.push(READ_ID);
                    break;
                case ABSPOINTER_DISABLE:
                    this.enabled = false;
                    this.absolute = false;
                    this.queue.length = 0;
                    this.bus.send("vmware-absolute-mouse", false);
                    break;
                case ABSPOINTER_ABSOLUTE | 0:
                    this.absolute = true;
                    this.bus.send("vmware-absolute-mouse", true);
                    break;
                case ABSPOINTER_RELATIVE | 0:
                    this.absolute = false;
                    this.bus.send("vmware-absolute-mouse", false);
                    break;
            }
            return 0;
    }

    return 0xFFFFFFFF | 0;
};

VMwareMouse.prototype.port_write32 = function() {};

VMwareMouse.prototype.get_state = function()
{
    return [this.enabled, this.absolute];
};

VMwareMouse.prototype.set_state = function(state)
{
    this.enabled = state[0];
    this.absolute = state[1];
    this.bus.send("vmware-absolute-mouse", this.absolute);
};
