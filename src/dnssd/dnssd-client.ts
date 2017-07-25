/*
 * dnssd-client.ts
 *
 * Copyright (C) 2017 David Lechner <david@lechnology.com>
 *
 * Based on dnssd_clientstub.c:
 * Copyright (c) 2003-2004, Apple Computer, Inc. All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1.  Redistributions of source code must retain the above copyright notice,
 *     this list of conditions and the following disclaimer.
 * 2.  Redistributions in binary form must reproduce the above copyright notice,
 *     this list of conditions and the following disclaimer in the documentation
 *     and/or other materials provided with the distribution.
 * 3.  Neither the name of Apple Computer, Inc. ("Apple") nor the names of its
 *     contributors may be used to endorse or promote products derived from this
 *     software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY APPLE AND ITS CONTRIBUTORS "AS IS" AND ANY
 * EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL APPLE OR ITS CONTRIBUTORS BE LIABLE FOR ANY
 * DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
 * (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
 * LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
 * ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
 * SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

import * as buffer from 'buffer';
import * as fs from 'fs';
import * as net from 'net';
import * as process from 'process';
import * as util from 'util';

const VERSION: number = 1;
const MDNS_UDS_SERVERPATH: string = '/var/run/mDNSResponder';
const MDNS_TCP_SERVERADDR: string = '127.0.0.1';
const CTL_PATH_PREFIX: string = '/tmp/dnssd_clippath.';
const USE_TCP_LOOPBACK: boolean = !fs.existsSync(MDNS_UDS_SERVERPATH);
const SIZEOF_HEADER: number = 28;

const IPC_FLAGS_NOREPLY: number = 1;
const IPC_FLAGS_REUSE_SOCKET: number = 2;

enum RequestOp {
    Connection = 1,
    RegRecordRequest,
    RemoveRecordRequest,
    EnumerationRequest,
    RegServiceRequest,
    BrowseRequest,
    ResolveRequest,
    QueryRequest,
    ReconfirmRecordRequest,
    AddRecordRequest,
    UpdateRecordRequest,
    SetDomainRequest
}

enum ReplyOp {
    EnumerationReply = 64,
    RegServiceReply,
    BrowseReply,
    ResolveReply,
    QueryReply,
    RegRecordReply
}

/**
 * Possible error code values.
 */
export enum ServiceErrorCode {
    NoError             = 0,
    Unknown             = -65537,
    NoSuchName          = -65538,
    NoMemory            = -65539,
    BadParam            = -65540,
    BadReference        = -65541,
    BadState            = -65542,
    BadFlags            = -65543,
    Unsupported         = -65544,
    NotInitialized      = -65545,
    AlreadyRegistered   = -65547,
    NameConflict        = -65548,
    Invalid             = -65549,
    Firewall            = -65550,
    Incompatible        = -65551,
    BadInterfaceIndex   = -65552,
    Refused             = -65553,
    NoSuchRecord        = -65554,
    NoAuth              = -65555,
    NoSuchKey           = -65556,
    NATTraversal        = -65557,
    DoubleNAT           = -65558,
    BadTime             = -65559
}

/**
 * Wraps ServiceErrorCode for throwing exceptions.
 */
export class ServiceError extends Error {
    /**
     * Creates a new instance of ServiceError.
     * @param code The error code.
     * @param message A useful message.
     */
    constructor(public code: ServiceErrorCode, message: string) {
        super(message);
    }
}

/**
 * General flags used in functions.
 */
export enum ServiceFlags {
    /**
     * MoreComing indicates to a callback that at least one more result is
     * queued and will be delivered following immediately after this one.
     * Applications should not update their UI to display browse
     * results when the MoreComing flag is set, because this would
     * result in a great deal of ugly flickering on the screen.
     * Applications should instead wait until until MoreComing is not set,
     * and then update their UI.
     *
     * When MoreComing is not set, that doesn't mean there will be no more
     * answers EVER, just that there are no more answers immediately
     * available right now at this instant. If more answers become available
     * in the future they will be delivered as usual.
     */
    MoreComing          = 0x1,

    /**
     * Flag for domain enumeration and browse/query reply callbacks.
     * An enumeration callback with the "Add" flag NOT set indicates a "Remove",
     * i.e. the domain is no longer valid.
     */
    Add                 = 0x2,

    /**
     * Flag for domain enumeration and browse/query reply callbacks.
     * "Default" applies only to enumeration and is only valid in
     * conjunction with "Add".
     */
    Default             = 0x4,

    /**
     * Flag for specifying renaming behavior on name conflict when registering
     * non-shared records. By default, name conflicts are automatically handled
     * by renaming the service.  NoAutoRename overrides this behavior - with this
     * flag set, name conflicts will result in a callback.  The NoAutoRename flag
     * is only valid if a name is explicitly specified when registering a service
     * (i.e. the default name is not used.)
     */
    NoAutoRename        = 0x8,

    /**
     * Flag for registering individual records on a connected Service.
     * Shared indicates that there may be multiple records with this name on
     * the network (e.g. PTR records).
     */
    Shared              = 0x10,

    /**
     * Flag for registering individual records on a connected Service.
     * Unique indicates that the record's name is to be unique on the network
     * (e.g. SRV records).
     */
    Unique              = 0x20,

    /**
     * Flag for specifying domain enumeration type in Service.enumerateDomains().
     * Enumerates domains recommended for browsing.
     */
    BrowseDomains       = 0x40,

    /**
     * Flag for specifying domain enumeration type in Service.enumerateDomains().
     * Enumerates domains recommended for registration.
     */
    RegistrationDomains = 0x80,

    /**
     * Flag for creating a long-lived unicast query for the Service.queryRecord call.
     */
    LongLivedQuery      = 0x100,

    /**
     * Flag for creating a record for which we will answer remote queries
     * (queries from hosts more than one hop away; hosts not directly connected
     * to the local link).
     */
    AllowRemoteQuery    = 0x200,

    /**
     * Flag for signifying that a query or registration should be performed
     * exclusively via multicast DNS, even for a name in a domain (e.g.
     * foo.apple.com.) that would normally imply unicast DNS.
     */
    ForceMulticast      = 0x400
}

/**
 * Service record types.
 */
export enum ServiceType {
    /**
     * Host address.
     */
    A         = 1,
    
    /**
     * Authoritative server.
     */
    NS        = 2,
    
    /**
     * Mail destination.
     */
    MD        = 3,
    
    /**
     * Mail forwarder.
     */
    MF        = 4,
    
    /**
     * Canonical name.
     */
    CNAME     = 5,
    
    /**
     * Start of authority zone.
     */
    SOA       = 6,
    
    /**
     * Mailbox domain name.
     */
    MB        = 7,
    
    /**
     * Mail group member.
     */
    MG        = 8,
    
    /**
     * Mail rename name.
     */
    MR        = 9,
    
    /**
     * Null resource record.
     */
    NULL      = 10,
    
    /**
     * Well known service.
     */
    WKS       = 11,
    
    /**
     * Domain name pointer.
     */
    PTR       = 12,
    
    /**
     * Host information.
     */
    HINFO     = 13,
    
    /**
     * Mailbox information.
     */
    MINFO     = 14,
    
    /**
     * Mail routing information.
     */
    MX        = 15,
    
    /**
     * One or more text strings.
     */
    TXT       = 16,
    
    /**
     * Responsible person.
     */
    RP        = 17,
    
    /**
     * AFS cell database.
     */
    AFSDB     = 18,
    
    /**
     * X_25 calling address.
     */
    X25       = 19,
    
    /**
     * ISDN calling address.
     */
    ISDN      = 20,
    
    /**
     * Router.
     */
    RT        = 21,
    
    /**
     * NSAP address.
     */
    NSAP      = 22,
    
    /**
     * Reverse NSAP lookup (deprecated).
     */
    NSAP_PTR  = 23,
    
    /**
     * Security signature.
     */
    SIG       = 24,
    
    /**
     * Security key.
     */
    KEY       = 25,
    
    /**
     * X.400 mail mapping.
     */
    PX        = 26,
    
    /**
     * Geographical position (withdrawn).
     */
    GPOS      = 27,
    
    /**
     * Ip6 Address.
     */
    AAAA      = 28,
    
    /**
     * Location Information.
     */
    LOC       = 29,
    
    /**
     * Next domain (security).
     */
    NXT       = 30,
    
    /**
     * Endpoint identifier.
     */
    EID       = 31,
    
    /**
     * Nimrod Locator.
     */
    NIMLOC    = 32,
    
    /**
     * Server Selection.
     */
    SRV       = 33,
    
    /**
     * ATM Address
     */
    ATMA      = 34,
    
    /**
     * Naming Authority PoinTeR
     */
    NAPTR     = 35,
    
    /**
     * Key Exchange
     */
    KX        = 36,
    
    /**
     * Certification record
     */
    CERT      = 37,
    
    /**
     * IPv6 address (deprecates AAAA)
     */
    A6        = 38,
    
    /**
     * Non-terminal DNAME (for IPv6)
     */
    DNAME     = 39,
    
    /**
     * Kitchen sink (experimentatl)
     */
    SINK      = 40,
    
    /**
     * EDNS0 option (meta-RR)
     */
    OPT       = 41,
    
    /**
     * Transaction key
     */
    TKEY      = 249,
    
    /**
     * Transaction signature.
     */
    TSIG      = 250,
    
    /**
     * Incremental zone transfer.
     */
    IXFR      = 251,
    
    /**
     * Transfer zone of authority.
     */
    AXFR      = 252,
    
    /**
     * Transfer mailbox records.
     */
    MAILB     = 253,
    
    /**
     * Transfer mail agent records.
     */
    MAILA     = 254,

    /**
     * Wildcard match.
     */
    ANY       = 255
}

/**
 * Service record classes.
 */
export enum ServiceClass {
    /**
     * Internet
     */
    IN       = 1
};

interface IpcMsgHeader {
    version: number;
    dataLen: number;
    flags: number;
    op: RequestOp | ReplyOp;
    context0: number;
    context1: number;
    regIndex: number;
}

/**
 * Runtime check to see if mDNSResponder daemon is running.
 * @return true if it is running
 */
export function checkDaemonRunning(): boolean {
    // FIXME: need to handle USE_TCP_LOOPBACK
    return fs.existsSync(MDNS_UDS_SERVERPATH);
}

/**
 * Callback for Service.browse().
 * @param service   The object initialized by Service.browse().
 * @param flags     Possible values are ServiceFlags.MoreComing and ServiceFlags.Add.
 *                  See flag definitions for details.
 * @param iface     The interface on which the service is advertised. This index should
 *                  be passed to Service.resolve() when resolving the service.
 * @param errorCode Will be ServiceError.NoError (0) on success, otherwise will
 *                  indicate the failure that occurred. Other parameters are undefined if
 *                  the errorCode is nonzero.
 * @param name      The discovered service name. This name should be displayed to the user,
 *                  and stored for subsequent use in the Service.resolve() call.
 * @param type      The service type, which is usually (but not always) the same as was passed
 *                  to Service.browse(). One case where the discovered service type may
 *                  not be the same as the requested service type is when using subtypes:
 *                  The client may want to browse for only those ftp servers that allow
 *                  anonymous connections. The client will pass the string "_ftp._tcp,_anon"
 *                  to Service.browse(), but the type of the service that's discovered
 *                  is simply "_ftp._tcp". The type for each discovered service instance
 *                  should be stored along with the name, so that it can be passed to
 *                  Service.resolve() when the service is later resolved.
 * @param domain    The domain of the discovered service instance. This may or may not be the
 *                  same as the domain that was passed to Service.browse(). The domain for each
 *                  discovered service instance should be stored along with the name, so that
 *                  it can be passed to Service.resolve() when the service is later resolved.
 */
export type BrowseReply = (service: Service, flags: ServiceFlags, iface: number,
    errorCode: ServiceErrorCode, name: string, type: string, domain: string) => void;

/**
 * Callback for Service.resolve().
 * @param service   The Service object initialized by Service.resolve().
 * @param flags     Currently unused, reserved for future use.
 * @param iface     The interface on which the service was resolved.
 * @param errorCode Will be ServiceError.NoError (0) on success, otherwise will
 *                  indicate the failure that occurred.  Other parameters are undefined if
 *                  the errorCode is nonzero.
 * @param fullName  The full service domain name, in the form <servicename>.<protocol>.<domain>.
 *                  (This name is escaped following standard DNS rules, making it suitable for
 *                  passing to standard system DNS APIs such as res_query(), or to the
 *                  special-purpose functions included in this API that take fullname parameters.
 *                  See "Notes on DNS Name Escaping" earlier in this file for more details.)
 * @param hostTarget The target hostname of the machine providing the service.  This name can
 *                  be passed to functions like gethostbyname() to identify the host's IP address.
 * @param port      The port on which connections are accepted for this service.
 * @param txt       The service's primary txt record.
 */
export type ResolveReply = (service: Service, flags: ServiceFlags, iface: number,
    errCode: ServiceErrorCode, fullName: string, hostTarget: string, port: number, txt: string[]) => void;

/**
 * Callback for Service.queryRecord().
 * @param service   The Service object initialized by Service.queryRecord().
 * @param flags     Possible values are ServiceFlags.MoreComing and
 *                  ServiceFlagsA.dd.  The Add flag is NOT set for PTR records
 *                  with a ttl of 0, i.e. "Remove" events.
 * @param iface     The interface on which the query was resolved (the index for a given
 *                  interface is determined via the if_nametoindex() family of calls).
 *                  See "Constants for specifying an interface index" for more details.
 * @param errCode   Will be ServiceErrorCode.NoError on success, otherwise will
 *                  indicate the failure that occurred.  Other parameters are undefined if
 *                  errCode is nonzero.
 * @param fullname  The resource record's full domain name.
 * @param rrType    The resource record's type (e.g. ServiceType.PTR, ServiceType.SRV, etc)
 * @param rrClass   The class of the resource record (usually ServiceClass.IN).
 * @param rdata     The raw rdata of the resource record.
 * @param ttl       The resource record's time to live, in seconds.
 */
export type QueryRecordReply = (service: Service, flags: ServiceFlags, iface: number,
    errCode: ServiceErrorCode, fullName: string, rrType: ServiceType,
    rrClass: ServiceClass, rData: Buffer, ttl: number) => void;

/**
 * Object that represents a connection to the mDNSResponder daemon. Instances
 * should be created using the static methods.
 */
export class Service {
    private op: RequestOp;
    private processReply: (header: IpcMsgHeader, data: Buffer) => void;
    private appCallback: BrowseReply | ResolveReply | QueryRecordReply;

    private constructor(private socket: net.Socket) {
    }

    private static connectToServer(): Promise<Service> {
        return new Promise((resolve, reject) => {
            const socket = net.createConnection(MDNS_UDS_SERVERPATH);
            socket.once('connect', () => {
                resolve(new Service(socket));
            });
            socket.once('error', (err) => {
                reject(err);
            });
        });
    }

    private async deliverRequest(msg: Buffer, reuseSd: boolean): Promise<void> {
        let listenServer: net.Server;
        let errSocket: net.Socket;
        if (!reuseSd) {
            listenServer = net.createServer(socket =>  {
                errSocket = socket;
            });
            if (USE_TCP_LOOPBACK) {
                const port = msg.readUInt16BE(SIZEOF_HEADER);
                listenServer.listen(port, MDNS_TCP_SERVERADDR);
            }
            else {
                const nullTermIndex = msg.indexOf(0, SIZEOF_HEADER);
                const path = msg.toString(undefined, SIZEOF_HEADER, nullTermIndex);
                listenServer.listen(path);
            }
        }
        await this.write(msg);
        try {
            // FIXME: check errSocket instead if !reuseSd
            const data = await this.read(4);
            const err = data.readUInt32BE(0);
            if (err != 0) {
                throw new ServiceError(err, 'Request error');
            }
        }
        finally {
            if (!reuseSd) {
                listenServer.close();
                errSocket.destroy();
            }
        }
    }

    /**
     * Read a reply from the daemon, calling the appropriate application callback. Note that the
     * client is responsible for ensuring that processResult() is called whenever there is
     * a reply from the daemon - the daemon may terminate its connection with a client that does not
     * process the daemon's responses.
     */
    public async processResult(): Promise<void> {
        const headerBuf = await this.read(SIZEOF_HEADER);
        const header = <IpcMsgHeader> {
            version: headerBuf.readUInt32BE(0),
            dataLen: headerBuf.readUInt32BE(4),
            flags: headerBuf.readUInt32BE(8),
            op: headerBuf.readUInt32BE(12),
            context0: headerBuf.readUInt32BE(16),
            context1: headerBuf.readUInt32BE(20),
            regIndex: headerBuf.readUInt32BE(24),
        };
        if (header.version != VERSION) {
            throw new ServiceError(ServiceErrorCode.Incompatible, 'Incompatible version');
        }
        const data = await this.read(header.dataLen);
        this.processReply(header, data);
    }

    /**
     * Terminate a connection with the daemon.
     * Any services or records registered with this object will be unregistered. Any
     * Browse, Resolve, or Query operations called with this object will be terminated.
     *
     * Note: If the object's underlying socket is used in a run loop or select() call, it should
     * be removed BEFORE destroy() is called, as this function closes the object's
     * socket.
     */
    public destroy(): void {
        this.socket.destroy();
    }

    private read(size: number): Promise<Buffer> {
        const data = this.socket.read(size);
        if (data) {
            return Promise.resolve(data);
        }
        return new Promise((resolve, reject) => {
            this.socket.once('readable', () => {
                const data = this.socket.read(size);
                resolve(data);
            });
        })
    }

    private write(msg: Buffer): Promise<void> {
        if (this.socket.write(msg)) {
            return Promise.resolve();
        };
        return new Promise((resolve, reject) => {
            this.socket.once('drain', () => resolve());
        });
    }

    private static createHeader(op: RequestOp, length: number, reuseSocket: boolean): [Buffer, number] {
        let ctrlPathOrPort: Buffer;
        let ctrlPathOrPortSize: number = 0;
        if (!reuseSocket) {
            if (USE_TCP_LOOPBACK) {
                ctrlPathOrPort = Buffer.alloc(2);
                ctrlPathOrPortSize = 2; // for port number
            }
            else {
                const now = Date.now();
                const ctrlPath = util.format('%s%d-%s-%d\0', CTL_PATH_PREFIX, process.pid,
                    (Math.floor(now / 1000000) & 0xFFFF).toString(16), now % 1000000);
                ctrlPathOrPort = Buffer.from(ctrlPath);
                ctrlPathOrPortSize = ctrlPathOrPort.length;
            }
        }
        const msg = Buffer.alloc(SIZEOF_HEADER + ctrlPathOrPortSize + length);
        let flags: number = 0;
        if (reuseSocket) {
            flags |= IPC_FLAGS_REUSE_SOCKET;
        }
        let offset = 0;
        offset = msg.writeUInt32BE(1, offset); // version = 1
        offset = msg.writeUInt32BE(ctrlPathOrPortSize + length, offset); // datalen
        offset = msg.writeUInt32BE(flags, offset);
        offset = msg.writeUInt32BE(op, offset);
        offset = msg.writeUInt32BE(0, offset); // context[0]
        offset = msg.writeUInt32BE(0, offset); // context[1]
        offset = msg.writeUInt32BE(0, offset); // reg_index
        if (!reuseSocket) {
            offset += ctrlPathOrPort.copy(msg, offset);
        }
        return [msg, offset]
    }

    /**
     * Browse for instances of a service.
     *
     * @param flags     Currently ignored, reserved for future use.
     * @param iface     If non-zero, specifies the interface on which to browse for services
     *                  (the index for a given interface is determined via the if_nametoindex()
     *                  family of calls.)  Most applications will pass 0 to browse on all available
     *                  interfaces. See "Constants for specifying an interface index" for more details.
     * @param type      The service type being browsed for followed by the protocol, separated by a
     *                  dot (e.g. "_ftp._tcp").  The transport protocol must be "_tcp" or "_udp".
     * @param domain    If non-empty, specifies the domain on which to browse for services.
     *                  Most applications will not specify a domain, instead browsing on the
     *                  default domain(s).
     * @param callback  The function to be called when an instance of the service being browsed for
     *                  is found.
     * @return          A promise for a new Service object.
     */
    public static async browse(flags: ServiceFlags, iface: number, type: string,
        domain: string, callback: BrowseReply): Promise<Service> {

        const regTypeBuf = Buffer.from(type + '\0');
        const domainBuf = Buffer.from(domain + '\0');

        let length = 4; // size of flags
        length += 4 // size of interfaceIndex
        length += regTypeBuf.length;
        length += domainBuf.length;

        let [msg, offset] = Service.createHeader(RequestOp.BrowseRequest, length, true);
        offset = msg.writeUInt32BE(0, offset); // flags
        offset = msg.writeUInt32BE(0, offset); // interfaceIndex = kServiceInterfaceIndexAny
        offset += regTypeBuf.copy(msg, offset);
        offset += domainBuf.copy(msg, offset);

        const service = await Service.connectToServer();
        await service.deliverRequest(msg, true);
        service.op = RequestOp.BrowseRequest;
        service.processReply = service.handleBrowseResponse;
        service.appCallback = callback;

        return service;
    }

    private handleBrowseResponse(header: IpcMsgHeader, data: Buffer): void {
        const flags = <ServiceFlags> data.readUInt32BE(0);
        const ifaceIndex = data.readUInt32BE(4);
        let errCode = <ServiceErrorCode> data.readInt32BE(8);
        let offset = 12;
        let strError = false;
        let replyName, replyType, replyDomain: string;

        let nullTermIndex = data.indexOf(0, offset);
        if (nullTermIndex < 0) {
            strError = true;
        }
        else {
            replyName = data.toString(undefined, offset, nullTermIndex);
            offset = nullTermIndex + 1;
        }

        nullTermIndex = data.indexOf(0, offset);
        if (nullTermIndex < 0) {
            strError = true;
        }
        else {
            replyType = data.toString(undefined, offset, nullTermIndex);
            offset = nullTermIndex + 1;
        }

        nullTermIndex = data.indexOf(0, offset);
        if (nullTermIndex < 0) {
            strError = true;
        }
        else {
            replyDomain = data.toString(undefined, offset, nullTermIndex);
            offset = nullTermIndex + 1;
        }

        if (!errCode && strError) {
            errCode = ServiceErrorCode.Unknown;
        }

        (<BrowseReply> this.appCallback)(this, flags, ifaceIndex, errCode, replyName, replyType, replyDomain);
    }

    /**
     * Resolve a service name discovered via browse() to a target host name, port number, and
     * txt record.
     *
     * Note: Applications should NOT use resolve() solely for txt record monitoring - use
     * queryRecord() instead, as it is more efficient for this task.
     *
     * Note: When the desired results have been returned, the client MUST terminate the resolve by calling
     * destroy().
     *
     * Note: resolve() behaves correctly for typical services that have a single SRV record
     * and a single TXT record. To resolve non-standard services with multiple SRV or TXT records,
     * queryRecord() should be used.
     *
     * @param flags     Currently ignored, reserved for future use.
     *
     * @param iface     The interface on which to resolve the service. If this resolve call is
     *                  as a result of a currently active browse() operation, then the
     *                  iface should be the index reported in the BrowseReply
     *                  callback. If this resolve call is using information previously saved
     *                  (e.g. in a preference file) for later use, then use iface 0, because
     *                  the desired service may now be reachable via a different physical interface.
     *                  See "Constants for specifying an interface index" for more details.
     *
     * @param name      The name of the service instance to be resolved, as reported to the
     *                  BrowseReply() callback.
     *
     * @param type      The type of the service instance to be resolved, as reported to the
     *                  BrowseReply() callback.
     *
     * @param domain    The domain of the service instance to be resolved, as reported to the
     *                  BrowseReply() callback.
     *
     * @param callback  The function to be called when a result is found.
     *
     * @return          A promise for a Service object. The resolve operation will run
     *                  indefinitely until the client terminates it by calling destroy().
     */
    public async resolve(flags: ServiceFlags, iface: number, name: string, type: string, domain: string,
        callback: ResolveReply): Promise<Service> {

        const nameBuf = Buffer.from(name + '\0');
        const typeBuf = Buffer.from(type + '\0');
        const domainBuf = Buffer.from(domain + '\0');

        let length = 4; // size of flags
        length += 4; // size of interfaceIndex
        length += nameBuf.length;
        length += typeBuf.length;
        length += domainBuf.length;

        let [msg, offset] = Service.createHeader(RequestOp.ResolveRequest, length, true);
        offset = msg.writeUInt32BE(flags, offset);
        offset = msg.writeUInt32BE(iface, offset);
        offset += nameBuf.copy(msg, offset);
        offset += typeBuf.copy(msg, offset);
        offset += domainBuf.copy(msg, offset);

        const service = await Service.connectToServer();
        await service.deliverRequest(msg, true);
        service.op = RequestOp.ResolveRequest;
        service.processReply = service.handleResolveResponse;
        service.appCallback = callback;

        return service;
    }

    private handleResolveResponse(header: IpcMsgHeader, data: Buffer): void {
        const flags = <ServiceFlags> data.readUInt32BE(0);
        const iface = data.readUInt32BE(4);
        let errCode = <ServiceErrorCode> data.readInt32BE(8);

        let offset = 12;
        let strError = false;
        let fullName, target: string;

        let nullTermIndex = data.indexOf(0, offset);
        if (nullTermIndex < 0) {
            strError = true;
        }
        else {
            fullName = data.toString(undefined, offset, nullTermIndex);
            offset = nullTermIndex + 1;
        }

        nullTermIndex = data.indexOf(0, offset);
        if (nullTermIndex < 0) {
            strError = true;
        }
        else {
            target = data.toString(undefined, offset, nullTermIndex);
            offset = nullTermIndex + 1;
        }

        const port = data.readUInt16BE(offset);
        const txtLen = data.readUInt16BE(offset + 2);
        offset += 4;
        const end = offset + txtLen;
        const txt = new Array<string>();
        while (offset < end) {
            const len = data.readUInt8(offset);
            offset += 1;
            txt.push(data.toString(undefined, offset, offset + len));
            offset += len;
        }

        if (!errCode && strError) {
            errCode = ServiceErrorCode.Unknown;
        }

        (<ResolveReply> this.appCallback)(this, flags, iface, errCode, fullName, target, port, txt);
    }

    /**
     * @param flags     Pass ServiceFlags.LongLivedQuery to create a "long-lived" unicast
     *                  query in a non-local domain.  Without setting this flag, unicast queries
     *                  will be one-shot - that is, only answers available at the time of the call
     *                  will be returned.  By setting this flag, answers (including Add and Remove
     *                  events) that become available after the initial call is made will generate
     *                  callbacks.  This flag has no effect on link-local multicast queries.
     * @param iface     If non-zero, specifies the interface on which to issue the query
     *                  (the index for a given interface is determined via the if_nametoindex()
     *                  family of calls.)  Passing 0 causes the name to be queried for on all
     *                  interfaces. See "Constants for specifying an interface index" for more details.
     * @param fullName  The full domain name of the resource record to be queried for.
     * @param rrType    The numerical type of the resource record to be queried for
     *                  (e.g. ServiceType.PTR, ServiceType.SRV, etc)
     * @param rrClass   The class of the resource record (usually ServiceClass.IN).
     * @param callback  The function to be called when a result is found, or if the call
     *                  asynchronously fails.
     */
    public async queryRecord(flags: ServiceFlags, iface: number, fullName: string, rrType: ServiceType,
        rrClass: ServiceClass, callback: QueryRecordReply): Promise<Service>
    {
        const nameBuf = Buffer.from(fullName + '\0');
        let length = 4; // size of flags
        length += 4; // size of iface
        length += nameBuf.length;
        length += 2; //size of rrType
        length += 2; //size of rrClass

        let [msg, offset] = Service.createHeader(RequestOp.QueryRequest, length, true);
        offset = msg.writeUInt32BE(flags, offset);
        offset = msg.writeUInt32BE(iface, offset);
        offset += nameBuf.copy(msg, offset);
        offset = msg.writeUInt16BE(rrType, offset);
        offset = msg.writeUInt16BE(rrClass, offset);

        const service = await Service.connectToServer();
        await service.deliverRequest(msg, true);
        service.op = RequestOp.QueryRequest;
        service.processReply = service.handleQueryResponse;
        service.appCallback = callback;

        return service;
    }

    private handleQueryResponse(header: IpcMsgHeader, data: Buffer): void {
        const flags = <ServiceFlags> data.readUInt32BE(0);
        const iface = data.readUInt32BE(4);
        const errCode = <ServiceErrorCode> data.readUInt32BE(8);

        let offset = 12;
        let strError = false;
        let fullName: string;

        let nullTermIndex = data.indexOf(0, offset);
        if (nullTermIndex < 0) {
            strError = true;
        }
        else {
            fullName = data.toString(undefined, offset, nullTermIndex);
            offset = nullTermIndex + 1;
        }

        const rrType = <ServiceType> data.readUInt16BE(offset + 0);
        const rrClass = <ServiceClass> data.readUInt16BE(offset + 2);
        const rdLen = data.readUInt16BE(offset + 4);
        offset += 6;
        const rData = Buffer.alloc(rdLen);
        data.copy(rData, 0, offset, offset + rdLen);
        offset += rdLen;
        const ttl = data.readUInt32BE(offset);
        (<QueryRecordReply> this.appCallback)(this, flags, iface, errCode, fullName, rrType, rrClass, rData, ttl);
    }
}
