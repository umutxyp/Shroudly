using System;
using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class ShroudlyEngine
{
    private const int    WINDIVERT_LAYER_NETWORK   = 0;
    private const int    MAX_PACKET                = 0xFFFF;
    private const ulong  WINDIVERT_HELPER_NO_REPLACE = 0;

    private static readonly ConcurrentDictionary<string, int> FlowPackets =
        new ConcurrentDictionary<string, int>();

    private static volatile bool Running = true;

    // ── WinDivert 1.4 P/Invoke ────────────────────────────────────────────────

    [DllImport("WinDivert.dll", CallingConvention = CallingConvention.Cdecl,
               CharSet = CharSet.Ansi, SetLastError = true)]
    private static extern IntPtr WinDivertOpen(
        string filter, int layer, short priority, ulong flags);

    [DllImport("WinDivert.dll", CallingConvention = CallingConvention.Cdecl,
               SetLastError = true)]
    private static extern bool WinDivertRecv(
        IntPtr handle, byte[] packet, uint packetLen, byte[] address, ref uint readLen);

    [DllImport("WinDivert.dll", CallingConvention = CallingConvention.Cdecl,
               SetLastError = true)]
    private static extern bool WinDivertSend(
        IntPtr handle, byte[] packet, uint packetLen, byte[] address, ref uint writeLen);

    [DllImport("WinDivert.dll", CallingConvention = CallingConvention.Cdecl,
               SetLastError = true)]
    private static extern bool WinDivertClose(IntPtr handle);

    // v1.4: no address parameter
    [DllImport("WinDivert.dll", CallingConvention = CallingConvention.Cdecl,
               SetLastError = true)]
    private static extern bool WinDivertHelperCalcChecksums(
        byte[] packet, uint packetLen, ulong flags);

    // ── Data types ────────────────────────────────────────────────────────────

    private sealed class Options
    {
        public int  FragmentSize      = 3;
        public int  MaxPacketsPerFlow = 1;
        public bool HttpHeaderCase    = true;
        public bool SplitHttp         = true;
        public bool SplitTls          = true;
        public bool SmartSplit        = true;   // SNI-aware split point
        public bool FakeSni           = true;   // send fake packet before real
        public bool Disorder          = true;   // send 2nd fragment before 1st
        public bool TripleSplit       = true;   // 3-fragment split
    }

    private sealed class PacketView
    {
        public int    IpHeaderLength;
        public int    TcpHeaderLength;
        public int    TcpOffset;
        public int    PayloadOffset;
        public int    PayloadLength;
        public ushort TotalLength;
        public ushort SourcePort;
        public ushort DestinationPort;
        public uint   SourceIp;
        public uint   DestinationIp;
        public uint   Sequence;
    }

    // ── Entry point ───────────────────────────────────────────────────────────

    private static int Main(string[] args)
    {
        Console.CancelKeyPress += (sender, e) =>
        {
            e.Cancel = true;
            Running  = false;
        };

        Options opts   = ParseOptions(args);
        string  filter = "outbound and ip and tcp and " +
                         "(tcp.DstPort == 80 or tcp.DstPort == 443)";

        IntPtr handle = WinDivertOpen(filter, WINDIVERT_LAYER_NETWORK, 0, 0);

        if (handle == IntPtr.Zero || handle.ToInt64() == -1)
        {
            Console.Error.WriteLine(
                "ERROR WinDivertOpen failed. " +
                "Run as administrator and verify WinDivert64.sys is present.");
            return 2;
        }

        Console.WriteLine("READY ShroudlyEngine active");

        byte[] packet  = new byte[MAX_PACKET];
        byte[] address = new byte[128];

        try
        {
            while (Running)
            {
                uint readLen = 0;
                Array.Clear(address, 0, address.Length);

                if (!WinDivertRecv(handle, packet, (uint)packet.Length, address, ref readLen))
                {
                    Thread.Sleep(1);
                    continue;
                }

                if (readLen == 0 || readLen > (uint)packet.Length)
                    continue;

                byte[] current = new byte[readLen];
                Buffer.BlockCopy(packet, 0, current, 0, (int)readLen);

                try
                {
                    if (!TryHandlePacket(handle, current, address, opts))
                        SendPacket(handle, current, address);
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine("PKT_ERR " + ex.Message);
                }
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("FATAL " + ex.Message);
            return 1;
        }
        finally
        {
            WinDivertClose(handle);
        }

        Console.WriteLine("STOP ShroudlyEngine stopped");
        return 0;
    }

    // ── Options ───────────────────────────────────────────────────────────────

    private static Options ParseOptions(string[] args)
    {
        var opts = new Options();
        for (int i = 0; i < args.Length; i++)
        {
            string arg = args[i];
            if (arg == "--fragment-size" && i + 1 < args.Length)
            {
                int v;
                if (int.TryParse(args[++i], out v)) opts.FragmentSize = Clamp(v, 1, 32);
            }
            else if (arg == "--max-packets-per-flow" && i + 1 < args.Length)
            {
                int v;
                if (int.TryParse(args[++i], out v)) opts.MaxPacketsPerFlow = Clamp(v, 1, 5);
            }
            else if (arg == "--no-http-case")    opts.HttpHeaderCase = false;
            else if (arg == "--no-http-split")   opts.SplitHttp      = false;
            else if (arg == "--no-tls-split")    opts.SplitTls       = false;
            else if (arg == "--no-smart-split")  opts.SmartSplit     = false;
            else if (arg == "--no-fake-sni")     opts.FakeSni        = false;
            else if (arg == "--no-disorder")     opts.Disorder       = false;
            else if (arg == "--no-triple-split") opts.TripleSplit    = false;
        }
        return opts;
    }

    // ── Main packet handler ───────────────────────────────────────────────────

    private static bool TryHandlePacket(
        IntPtr handle, byte[] packet, byte[] address, Options opts)
    {
        PacketView view;
        if (!TryParsePacket(packet, out view) || view.PayloadLength <= 0)
            return false;

        string flowKey = view.SourceIp.ToString() + ":" + view.SourcePort.ToString() + ">" +
                         view.DestinationIp.ToString() + ":" + view.DestinationPort.ToString();

        int count = FlowPackets.AddOrUpdate(flowKey, 1, (k, old) => old + 1);
        if (count > opts.MaxPacketsPerFlow)
            return false;

        // ── HTTP (port 80) ────────────────────────────────────────────────────
        if (view.DestinationPort == 80)
        {
            if (opts.HttpHeaderCase)
                RewriteHttpHostHeader(packet, view);

            if (opts.SplitHttp && view.PayloadLength > 1)
            {
                int splitAt = opts.SmartSplit
                    ? FindHttpSplitOffset(packet, view)
                    : opts.FragmentSize;

                if (splitAt <= 0 || splitAt >= view.PayloadLength)
                    splitAt = Clamp(opts.FragmentSize, 1, view.PayloadLength - 1);

                return SplitTwoWay(handle, packet, address, view, splitAt, opts.Disorder);
            }

            // Not splitting — recalculate if header was changed, then send
            Recalculate(packet, address);
            SendPacket(handle, packet, address);
            return true;
        }

        // ── HTTPS / TLS (port 443) ────────────────────────────────────────────
        if (view.DestinationPort == 443 && opts.SplitTls && view.PayloadLength > 1)
        {
            int sniRelOffset = -1;
            int sniLen       = 0;

            if (opts.SmartSplit)
                sniRelOffset = FindTlsSniOffset(packet, view, out sniLen);

            // Send fake packet first (scrambled SNI + bad checksum)
            if (opts.FakeSni && sniRelOffset > 0 && sniLen > 0)
                SendFakePacket(handle, packet, address, view, sniRelOffset, sniLen);

            // Choose split strategy
            if (opts.TripleSplit && sniRelOffset > 1 && sniRelOffset < view.PayloadLength - 1)
            {
                // Split: [0..firstByte] [firstByte+1..sniRelOffset-1] [sniRelOffset..end]
                int s1 = 1;
                int s2 = sniRelOffset;
                return SplitThreeWay(handle, packet, address, view, s1, s2, opts.Disorder);
            }

            // Two-way split
            int twoWaySplit = sniRelOffset > 0 && sniRelOffset < view.PayloadLength - 1
                ? sniRelOffset
                : Clamp(opts.FragmentSize, 1, view.PayloadLength - 1);

            return SplitTwoWay(handle, packet, address, view, twoWaySplit, opts.Disorder);
        }

        return false;
    }

    // ── TLS SNI detection ─────────────────────────────────────────────────────

    // Returns the SNI hostname offset relative to PayloadOffset (-1 if not found).
    // Also outputs sniLen (the byte length of the hostname).
    private static int FindTlsSniOffset(byte[] packet, PacketView view, out int sniLen)
    {
        sniLen = 0;

        int p   = view.PayloadOffset;
        int end = p + view.PayloadLength;

        // Need at least TLS record header (5) + HandshakeType (1)
        if (end - p < 6) return -1;

        // TLS Handshake record
        if (packet[p] != 0x16 || packet[p + 1] != 0x03) return -1;
        if (packet[p + 5] != 0x01) return -1;  // ClientHello

        // Skip: TLS header(5) + HandshakeType(1) + Length(3) + ClientVersion(2) + Random(32) = 43
        int pos = p + 43;
        if (pos >= end) return -1;

        // Session ID
        int sidLen = packet[pos];
        pos += 1 + sidLen;
        if (pos + 2 >= end) return -1;

        // Cipher suites
        int csLen = (packet[pos] << 8) | packet[pos + 1];
        pos += 2 + csLen;
        if (pos + 1 >= end) return -1;

        // Compression methods
        int cmLen = packet[pos];
        pos += 1 + cmLen;
        if (pos + 2 >= end) return -1;

        // Extensions total length
        int extLen = (packet[pos] << 8) | packet[pos + 1];
        pos += 2;
        int extEnd = Math.Min(pos + extLen, end);

        while (pos + 4 <= extEnd)
        {
            int eType = (packet[pos] << 8) | packet[pos + 1];
            int eLen  = (packet[pos + 2] << 8) | packet[pos + 3];
            pos += 4;

            if (eType == 0x0000 && eLen >= 5)  // server_name extension
            {
                // server_name_list_length (2) + name_type (1) + name_length (2) = 5
                if (pos + 5 > end) return -1;
                int nameLen = (packet[pos + 3] << 8) | packet[pos + 4];
                sniLen = nameLen;
                int hostnameAbsPos = pos + 5;  // absolute position in packet
                return hostnameAbsPos - view.PayloadOffset;  // relative to payload
            }

            pos += eLen;
        }

        return -1;
    }

    // ── HTTP split-point detection ────────────────────────────────────────────

    // Returns the best byte offset (relative to payload) to split an HTTP request.
    // Prefers splitting just before the "Host:" header.
    private static int FindHttpSplitOffset(byte[] packet, PacketView view)
    {
        int scanLen = Math.Min(view.PayloadLength, 768);
        string payload = Encoding.ASCII.GetString(packet, view.PayloadOffset, scanLen);

        // Split just before "Host:" (after the CRLF preceding it)
        int idx = payload.IndexOf("\r\nHost:", StringComparison.OrdinalIgnoreCase);
        if (idx >= 0)
        {
            int offset = idx + 2;  // after \r\n, pointing at "Host:"
            if (offset > 0 && offset < view.PayloadLength - 1) return offset;
        }

        // Fallback: split after first request line
        int firstCrlf = payload.IndexOf("\r\n");
        if (firstCrlf >= 0)
        {
            int offset = firstCrlf + 2;
            if (offset > 0 && offset < view.PayloadLength - 1) return offset;
        }

        return -1;
    }

    // ── HTTP Host header case scramble ────────────────────────────────────────

    private static bool RewriteHttpHostHeader(byte[] packet, PacketView view)
    {
        int scanLen = Math.Min(view.PayloadLength, 768);
        string payload = Encoding.ASCII.GetString(packet, view.PayloadOffset, scanLen);
        int idx = payload.IndexOf("Host:", StringComparison.OrdinalIgnoreCase);
        if (idx < 0) return false;

        byte[] replacement = Encoding.ASCII.GetBytes("hoSt:");
        Buffer.BlockCopy(replacement, 0, packet, view.PayloadOffset + idx, replacement.Length);
        return true;
    }

    // ── Fake packet (scrambled SNI + bad TCP checksum) ────────────────────────

    private static void SendFakePacket(
        IntPtr handle, byte[] packet, byte[] address,
        PacketView view, int sniRelOffset, int sniLen)
    {
        byte[] fake = new byte[packet.Length];
        Buffer.BlockCopy(packet, 0, fake, 0, packet.Length);

        // XOR-scramble the SNI hostname bytes so DPI reads garbage
        int absStart = view.PayloadOffset + sniRelOffset;
        for (int i = 0; i < sniLen && absStart + i < fake.Length; i++)
            fake[absStart + i] ^= 0x55;

        // Corrupt TCP checksum — server's TCP stack will drop this packet,
        // but the ISP's DPI (which often skips checksum validation) already read it.
        if (view.TcpOffset + 17 < fake.Length)
        {
            fake[view.TcpOffset + 16] ^= 0xFF;
            fake[view.TcpOffset + 17] ^= 0xFF;
        }

        uint written = 0;
        WinDivertSend(handle, fake, (uint)fake.Length, address, ref written);
    }

    // ── Two-way split ─────────────────────────────────────────────────────────

    private static bool SplitTwoWay(
        IntPtr handle, byte[] packet, byte[] address,
        PacketView view, int splitAt, bool disorder)
    {
        int p1Len = splitAt;
        int p2Len = view.PayloadLength - p1Len;
        if (p1Len <= 0 || p2Len <= 0) return false;

        int hdrLen = view.PayloadOffset;
        byte[] first  = new byte[hdrLen + p1Len];
        byte[] second = new byte[hdrLen + p2Len];

        Buffer.BlockCopy(packet, 0,                       first,  0,      hdrLen);
        Buffer.BlockCopy(packet, view.PayloadOffset,      first,  hdrLen, p1Len);

        Buffer.BlockCopy(packet, 0,                             second, 0,      hdrLen);
        Buffer.BlockCopy(packet, view.PayloadOffset + p1Len,   second, hdrLen, p2Len);

        WriteUInt16(first,  2, (ushort)first.Length);
        WriteUInt16(second, 2, (ushort)second.Length);
        WriteUInt32(second, view.TcpOffset + 4, view.Sequence + (uint)p1Len);

        Recalculate(first,  address);
        Recalculate(second, address);

        if (disorder)
        {
            // Send 2nd fragment first — TCP receiver buffers it and waits for 1st.
            // DPI systems that don't do proper reassembly fail to identify content.
            SendPacket(handle, second, address);
            SendPacket(handle, first,  address);
        }
        else
        {
            SendPacket(handle, first,  address);
            SendPacket(handle, second, address);
        }
        return true;
    }

    // ── Three-way split ───────────────────────────────────────────────────────

    private static bool SplitThreeWay(
        IntPtr handle, byte[] packet, byte[] address,
        PacketView view, int split1, int split2, bool disorder)
    {
        int p1Len = split1;
        int p2Len = split2 - split1;
        int p3Len = view.PayloadLength - split2;

        if (p1Len <= 0 || p2Len <= 0 || p3Len <= 0)
            return SplitTwoWay(handle, packet, address, view, split1, disorder);

        int hdrLen = view.PayloadOffset;
        byte[] f1 = new byte[hdrLen + p1Len];
        byte[] f2 = new byte[hdrLen + p2Len];
        byte[] f3 = new byte[hdrLen + p3Len];

        Buffer.BlockCopy(packet, 0, f1, 0, hdrLen);
        Buffer.BlockCopy(packet, 0, f2, 0, hdrLen);
        Buffer.BlockCopy(packet, 0, f3, 0, hdrLen);

        Buffer.BlockCopy(packet, view.PayloadOffset,          f1, hdrLen, p1Len);
        Buffer.BlockCopy(packet, view.PayloadOffset + split1, f2, hdrLen, p2Len);
        Buffer.BlockCopy(packet, view.PayloadOffset + split2, f3, hdrLen, p3Len);

        WriteUInt16(f1, 2, (ushort)f1.Length);
        WriteUInt16(f2, 2, (ushort)f2.Length);
        WriteUInt16(f3, 2, (ushort)f3.Length);

        WriteUInt32(f2, view.TcpOffset + 4, view.Sequence + (uint)p1Len);
        WriteUInt32(f3, view.TcpOffset + 4, view.Sequence + (uint)(p1Len + p2Len));

        Recalculate(f1, address);
        Recalculate(f2, address);
        Recalculate(f3, address);

        if (disorder)
        {
            // Disorder: send 3 → 1 → 2 so DPI never sees a coherent start
            SendPacket(handle, f3, address);
            SendPacket(handle, f1, address);
            SendPacket(handle, f2, address);
        }
        else
        {
            SendPacket(handle, f1, address);
            SendPacket(handle, f2, address);
            SendPacket(handle, f3, address);
        }
        return true;
    }

    // ── Packet parsing ────────────────────────────────────────────────────────

    private static bool TryParsePacket(byte[] packet, out PacketView view)
    {
        view = null;
        if (packet.Length < 40) return false;

        int version = packet[0] >> 4;
        if (version != 4) return false;

        int ipHeaderLength = (packet[0] & 0x0F) * 4;
        if (ipHeaderLength < 20 || packet.Length < ipHeaderLength + 20) return false;

        if (packet[9] != 6) return false;  // TCP only

        int tcpOffset      = ipHeaderLength;
        int tcpHeaderLength = (packet[tcpOffset + 12] >> 4) * 4;
        int payloadOffset  = tcpOffset + tcpHeaderLength;
        ushort totalLength = ReadUInt16(packet, 2);

        if (tcpHeaderLength < 20 || totalLength > packet.Length || payloadOffset > totalLength)
            return false;

        view = new PacketView
        {
            IpHeaderLength  = ipHeaderLength,
            TcpHeaderLength = tcpHeaderLength,
            TcpOffset       = tcpOffset,
            PayloadOffset   = payloadOffset,
            PayloadLength   = totalLength - payloadOffset,
            TotalLength     = totalLength,
            SourcePort      = ReadUInt16(packet, tcpOffset),
            DestinationPort = ReadUInt16(packet, tcpOffset + 2),
            Sequence        = ReadUInt32(packet, tcpOffset + 4),
            SourceIp        = ReadUInt32(packet, 12),
            DestinationIp   = ReadUInt32(packet, 16),
        };
        return true;
    }

    // ── Checksum / send helpers ───────────────────────────────────────────────

    private static void Recalculate(byte[] packet, byte[] address)
    {
        WriteUInt16(packet, 10, 0);
        int tcpOffset = (packet[0] & 0x0F) * 4;
        WriteUInt16(packet, tcpOffset + 16, 0);
        WinDivertHelperCalcChecksums(packet, (uint)packet.Length, WINDIVERT_HELPER_NO_REPLACE);
    }

    private static void SendPacket(IntPtr handle, byte[] packet, byte[] address)
    {
        uint written = 0;
        WinDivertSend(handle, packet, (uint)packet.Length, address, ref written);
    }

    // ── Byte helpers ──────────────────────────────────────────────────────────

    private static ushort ReadUInt16(byte[] data, int offset)
    {
        return (ushort)((data[offset] << 8) | data[offset + 1]);
    }

    private static uint ReadUInt32(byte[] data, int offset)
    {
        return ((uint)data[offset]      << 24) |
               ((uint)data[offset + 1] << 16) |
               ((uint)data[offset + 2] <<  8) |
                       data[offset + 3];
    }

    private static void WriteUInt16(byte[] data, int offset, ushort value)
    {
        data[offset]     = (byte)(value >> 8);
        data[offset + 1] = (byte) value;
    }

    private static void WriteUInt32(byte[] data, int offset, uint value)
    {
        data[offset]     = (byte)(value >> 24);
        data[offset + 1] = (byte)(value >> 16);
        data[offset + 2] = (byte)(value >>  8);
        data[offset + 3] = (byte) value;
    }

    private static int Clamp(int value, int min, int max)
    {
        return Math.Max(min, Math.Min(max, value));
    }
}
