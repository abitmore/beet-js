const OTPAuth = require('otpauth');
import CryptoJS from "crypto-js";
import browser from 'browser-detect';
import BeetClientDB from './lib/BeetClientDB';
import "isomorphic-fetch";
import {
    ec as EC
} from "elliptic";
let ec = new EC('curve25519');


let SSL_HOST = 'wss://local.get-beet.io:60556';
let LOCAL_HOST = 'ws://local.get-beet.io:60555';
let allowFallback = true;
let getWebSocketConnection = function (onopen = null, onmessage = null, onclose = null, onerror = null) {
    let host = SSL_HOST;
    let next = LOCAL_HOST;

    let _connect = function (host, next) {
        return new Promise((resolve, reject) => {
            let socket = new WebSocket(host);
            socket.onerror = function (event) {
                // only fallback for an error on first initialisation
                if (allowFallback && event.timeStamp < 2000 && next !== null) {
                    event.stopPropagation();
                    event.preventDefault();
                    console.log("Falling back to localhost socket", event);
                    _connect(next, null).then(socket => {
                        resolve(socket);
                    }).catch(reject);
                } else if (onerror != null) {
                    onerror(event, socket);
                }
            };
            socket.onopen = function (event) {
                resolve(socket);
                if (onopen !== null) {
                    onopen(event, socket);
                }
            };
            socket.onclose = function (event) {
                if (onclose !== null) {
                    onclose(event, socket);
                }
            };
            socket.onmessage = function (event) {
                if (onmessage !== null) {
                    onmessage(event, socket);
                }
            };
        });
    };
    return _connect(host, next);
};


class BeetJS {

    constructor() {
        this._beetAppInstances = {};
    }

    allowLocalhost() {
        allowFallback = true;
    }
    async get(appName) {
        if (this._beetAppInstances[appName]) {
            return this._beetAppInstances[appName];
        } else {
            let appInstance = new BeetApp(appName);
            await appInstance.init();
            this._beetAppInstances[appName] = appInstance;
            return this._beetAppInstances[appName];
        }
    }
    /**
     * Gets an instance of a beet connected application, and does the identity handling for the chain or chains provided.
     *      *
     * @param String appName The name of the application that wants to connect to beet
     * @param String or List chainSelector A string, or list of strings giving the chains the app wants an identity of
     * @returns Returns a dict with following keys: 'beet' contains the beet instance for this application,
     *           and one key for each entry in chainSelector, which contains the beet connection for that identity
     */

    async quickConnect(appName, chainSelector, forceToChoose = false) {
        let _beetConnectedApp = null;
        if (this._beetAppInstances[appName]) {
            _beetConnectedApp = this._beetAppInstances[appName];
        } else {
            let appInstance = new BeetApp(appName);
            await appInstance.init();
            this._beetAppInstances[appName] = appInstance;
            _beetConnectedApp = this._beetAppInstances[appName];
        }
        
        if (typeof chainSelector == "string") {
            chainSelector = [chainSelector]
        }
        if (typeof chainSelector !== "object" && chainSelector.length > 0 && typeof chainSelector[0] == "string" ) {
            throw "chainSelector must be null, a string or list of strings"
        }

        let returnValue = {beet: _beetConnectedApp};
        for (let idx in chainSelector) {
            let chain = chainSelector[idx];
            if (chain=='ANY') {
                returnValue[chain]=await _beetConnectedApp.getAnyConnection(!forceToChoose);                
            }else{
                returnValue[chain]=await _beetConnectedApp.getChainConnection(chain, !forceToChoose);
            }
        }
        return returnValue;
        
    }

    /**
     * Pings Beet by hecking the version
     *
     * @returns {Promise} Resolves to the installed version of Beet
     */
    ping() {
        return getWebSocketConnection(
            function (event, socket) {
                socket.send('{ "type" : "version"}');
            },
            function (event, socket) {
                let msg = JSON.parse(event.data);
                if (msg.type == "version") {
                    resolve(msg.result);
                } else {
                    reject(false);
                }
                socket.close();
            }
        );
    }

    /**
     * Uses ping() with a timeout to check if Beet is installed.
     *
     * @returns {Promise} Resolves to true (if installed) and false (not installed)
     */
    isInstalled() {
        return new Promise(resolve => {
            setTimeout(() => {
                resolve(false);
            }, 500);
            this.ping().then(found => {
                if (found) resolve(found);
            });

        })
    }

}
class BeetApp {

    constructor(appName) {
        this.appName = appName;
        this.origin = appName; // FIXME put in actual origin
        if (typeof location !== 'undefined') {
            if (location.hasOwnProperty('hostname') && location.hostname.length && location.hostname !== 'localhost') {
                this.origin = location.hostname;
            }
        }
        this.detected = browser();
        this.appHash = CryptoJS.SHA256(this.detected.name + ' ' + this.origin + ' ' + this.appName).toString();

    }

    async init() {
        this.appstore = await BeetClientDB.apps.where("apphash").equals(this.appHash).toArray();
        this._beetConnections = {};
    }

    list() {
        return this.appstore;
    }

    async getConnection(identity) {
        if (this._beetConnections[identity.identityhash]) {
            return this._beetConnections[identity.identityhash];
        } else {
            let beetConnection = new BeetConnection(this.appName);
            try {
                await beetConnection.connect(identity);
                this._beetConnections[identity.identityhash] = beetConnection;
                return this._beetConnections[identity.identityhash];
            } catch (err) {
                throw new Error(err);
                // TODO: if linking error, re-link transparently instead
            }
        }
    }

    async getChainConnection(chainType, existing = true) {
        if (existing) {
            let compatibleIdentities = this.appstore.filter(id => {
                return id.chain == chainType 
            });
            if (compatibleIdentities.length > 0) {
                try {
                    let beetConnection = this.getConnection(compatibleIdentities[0]);
                    return beetConnection;
                } catch (err) {
                    return this.getChainConnection(chainType, false);
                }
            }else{
                return this.getChainConnection(chainType, false);
            }
        } else {
            let beetConnection = new BeetConnection(this.appName);
            try {
                let isReady = await beetConnection.connect();
                let identityhash = await beetConnection.link(chainType);
                this._beetConnections[identityhash] = beetConnection;
                return this._beetConnections[identityhash];
            } catch (err) {
                throw new Error(err);
            }
        }
    }

    async getAnyConnection(existing = true) {
        if (existing) {

            if (this.appstore.length > 0) {
                try {
                    let beetConnection = this.getConnection(this.appstore[0]);
                    return beetConnection;
                } catch (err) {
                    return this.getAnyConnection(false);
                }
            }else{
                return this.getAnyConnection(false);
            }
        } else {
            let beetConnection = new BeetConnection(this.appName);
            try {
                let isReady = await beetConnection.connect();
                let identityhash = await beetConnection.link(); // Need to modify link to allow for no chain preference

                this._beetConnections[identityhash] = beetConnection;
                return this._beetConnections[identityhash];
            } catch (err) {
                throw new Error(err);
            }
        }
    }
}

class BeetConnection {

    constructor(appName) {
        this.connected = false; // State of WS Connection to Beet
        this.authenticated = false; // Whether this app has identified itself to Beet
        this.linked = false; // Whether this app has linked itself to a Beet account/id
        this.initialised = true; // Whether this client has been initialised (app name & domain/origin set)
        this.socket = null; // Holds the ws connection
        this.appName = appName; // Name/identifier of the app making use of this client
        this.otp = null; // Holds the one-time-password generation for the linked account
        this.openRequests = []; // Holds pending API request promises to be resolved upon beet response
        this.origin = null; // Holds domain-name/origin of this instance
        this.appName = appName;
        this.origin = appName; // FIXME put in actual origin
        if (typeof location !== 'undefined') {
            if (location.hasOwnProperty('hostname') && location.hostname.length && location.hostname !== 'localhost') {
                this.origin = location.hostname;
            }
        }
        this.detected = browser();
        this.apphash = CryptoJS.SHA256(this.detected.name + ' ' + this.origin + ' ' + this.appName).toString();
    }

    reset() {
        this.connected = false;
        this.authenticated = false;
        this.linked = false;
        this.socket = null;
        this.otp = null;
        this.openRequests = [];
        this.socket = null;
    }

    /**
     * Generates a random id for an API request
     *
     * @returns {number} A random id
     */
    generate_id() {
        return Math.round(Math.random() * 100000000 + 1);
    }
    // Used to get the available id for a request and replace it with a new one while also returning its hash
    async fetch_ids() {

        let app = await BeetClientDB.apps.where("identityhash").equals(this.identity.identityhash).first();
        let id = app.next_id;
        let new_id = await this.next_id();
        let next_hash = await CryptoJS.SHA256('' + new_id).toString();
        return {
            id: id,
            next_hash: next_hash.toString()
        };
    }

    /**
     * Generates a new id and stores it as the next one to be used
     *
     * @returns {number} The next id to be used
     */
    async next_id() {
        if (this.connected && this.authenticated && this.linked) {
            let new_id = this.generate_id();

            await BeetClientDB.apps.where("identityhash").equals(this.identity.identityhash).modify({
                next_id: new_id
            });
            return new_id;
        } else {
            throw new Error("You must be connected, authorised and linked.");
        }
    }

    /**
     * Requests to link to a Beet account/id on specified chain
     *
     * @param {String} chain Symbol of the chain to be linked
     * @returns {Promise} Resolves to false if not linked after timeout, or to result of 'link' Beet call
     */
    async link(chain = null) {
        return new Promise(async (resolve, reject) => {
            if (!this.connected) throw new Error("You must connect to Beet first.");
            if (!this.initialised) throw new Error("You must initialise the Beet Client first via init(appName).");
            setTimeout(() => {
                resolve(false);
            }, this.options.linkTimeout);
            let keypair = ec.genKeyPair();
            this.privk = keypair.getPrivate();
            let pubkey = keypair.getPublic().encode('hex');
            this.secret = keypair.derive(ec.keyFromPublic(this.beetkey, 'hex').getPublic());
            var next_id = Math.round(Math.random() * 100000000 + 1);
            this.chain = chain;
            var next_hash = await CryptoJS.SHA256('' + next_id);
            let linkobj = {
                chain: this.chain,
                pubkey: pubkey,
                next_hash: next_hash.toString()
            }
            if (this.chain == null) {
                linkobj.chain = 'ANY'
            }
            var link = this.sendRequest('link', linkobj);
            link.then(async res => {
                console.log("link result", res)
                this.chain = res.chain;
                if (res.existing) {
                    this.identityhash = res.identityhash;
                    try {
                        this.identity = await BeetClientDB.apps.where("identityhash").equals(this.identityhash).first();                                            
                        this.authenticated = res.authenticate;
                        this.linked = res.link;
                        
                        this.otp = new OTPAuth.HOTP({
                            issuer: "Beet",
                            label: "BeetAuth",
                            algorithm: "SHA1",
                            digits: 32,
                            counter: 0,
                            secret: OTPAuth.Secret.fromHex(this.identity.secret)
                        });
                        console.log("otp instantiated", this.identity.secret.toString());
                        resolve(this.identityhash);
                    }catch(e){
                        throw new Error('Beet has an established identity but client does not.');
                    }
                }else{
                    this.identityhash = res.identityhash;
                    this.appstore = await BeetClientDB.apps.add({
                        apphash: this.apphash,
                        identityhash: this.identityhash,                        
                        chain: this.chain,
                        appName: this.appName,
                        secret: this.secret.toString('hex'),
                        next_id: next_id
                    });
                    this.authenticated = res.authenticate;
                    this.linked = res.link;
                    this.identity = await BeetClientDB.apps.where("identityhash").equals(this.identityhash).first();

                    this.otp = new OTPAuth.HOTP({
                        issuer: "Beet",
                        label: "BeetAuth",
                        algorithm: "SHA1",
                        digits: 32,
                        counter: 0,
                        secret: OTPAuth.Secret.fromHex(this.identity.secret)
                    });
                    console.log("otp instantiated", this.identity.secret.toString());
                    resolve(this.identityhash);
                }
            }).catch(rej => {
                reject(rej);
            });
        });

    }

    /**
     * Connects to Beet instance. If one of the existing linked identities (returned by init()) is passed, it also tries to enable that link
     *
     * @param identity
     * @param options
     * @returns {Promise} Resolves to false if not connected after timeout, or to result of 'authenticate' Beet call
     */
    async connect(identity = null, options) {
        return new Promise((resolve, reject) => {
            if (!this.initialised) throw new Error("You must initialise the Beet Client first via init(appName).");

            // Setting options defaults
            this.options = Object.assign({
                initTimeout: 3000,
                linkTimeout: 30000
            }, options);

            // Auto failer
            setTimeout(() => {
                reject("Connection has timed out.");
            }, this.options.initTimeout);

            let authobj;
            if (identity != null) {
                this.identity = identity;
                authobj = {
                    origin: this.origin,
                    appName: this.appName,
                    browser: this.detected.name,
                    identityhash: this.identity.identityhash
                };
            } else {
                authobj = {
                    origin: this.origin,
                    appName: this.appName,
                    browser: this.detected.name,
                };
            }
            let onopen = async () => {
                this.connected = true;
                let auth = this.sendRequest('authenticate', authobj);
                auth.then(res => {
                    console.log("connect", res);
                    this.authenticated = res.authenticate;
                    this.linked = res.link;
                    if (this.linked) {
                        this.otp = new OTPAuth.HOTP({
                            issuer: "Beet",
                            label: "BeetAuth",
                            algorithm: "SHA1",
                            digits: 32,
                            counter: 0,
                            secret: OTPAuth.Secret.fromHex(this.identity.secret)
                        });
                        console.log("otp instantiated", this.identity.secret.toString());
                    } else {
                        this.beetkey = res.pub_key;
                    }
                    console.log(this.identity.secret);
                    resolve(res);
                }).catch(rej => {
                    resolve(rej);
                });
            };
            let onmessage = async (event) => {
                console.log("socket.onmessage", event);
                let msg = JSON.parse(event.data);
                const openRequest = this.openRequests.find(
                    (x) => {
                        return x.id === msg.id || x.id.toString() === msg.id
                    }
                );
                if (!openRequest) return;
                if (msg.error) {
                    if (msg.encrypted) {
                        this.otp.counter = msg.id;
                        let key = this.otp.generate();
                        var response = CryptoJS.AES.decrypt(msg.payload, key).toString(CryptoJS.enc.Utf8);
                        console.log("otp key generated", this.otp.counter);
                        console.log("socket.onmessage payload", response);
                        openRequest.reject(response);
                    } else {
                        openRequest.reject(msg.payload.message);
                    }
                    if (msg.payload.code == 2) {
                        await BeetClientDB.apps.where("identityhash").equals(this.identity.identityhash).delete();
                        this.reset();
                    }
                } else {
                    if (msg.encrypted) {
                        this.otp.counter = msg.id;
                        let key = this.otp.generate();
                        let response = CryptoJS.AES.decrypt(msg.payload, key).toString(CryptoJS.enc.Utf8);
                        console.log("otp key generated", this.otp.counter);
                        console.log("socket.onmessage payload", response);
                        openRequest.resolve(response);
                    } else {
                        openRequest.resolve(msg.payload);
                    }
                }
            };
            let onclose = function () {
                this.connected = false;
                this.socket = null;
            };
            getWebSocketConnection(
                onopen.bind(this),
                onmessage.bind(this),
                onclose.bind(this)
            ).then(socket => {
                this.socket = socket;
            }).catch(reject);
        })
    }

    /**
     * Sends a request to Beet. If it is an API request, it is encrypted with AES using a one-time-pass generated by the request id (as a counter) and a previously established shared secret with Beet (using ECDH)
     *
     * @param {string} type Name of the call to execute
     * @param {dict} payload
     * @returns {Promise} Resolving is done by Beet
     */
    async sendRequest(type, payload) {
        console.log("sendRequest", type, payload);
        return new Promise(async (resolve, reject) => {
            let request = {}
            request.type = type;
            if (type == 'api') {
                let ids = await this.fetch_ids();
                payload.next_hash = ids.next_hash;
                request.id = ids.id;
                this.otp.counter = request.id;
                let key = this.otp.generate();
                console.log("otp key generated", this.otp.counter);
                console.log("sendRequest payload", payload);
                request.payload = CryptoJS.AES.encrypt(JSON.stringify(payload), key).toString();
            } else {
                request.id = await this.generate_id();
                request.payload = payload;
            }
            this.openRequests.push(Object.assign(request, {
                resolve,
                reject
            }));
            this.socket.send(JSON.stringify(request));
            console.log('sendRequest dispatched', request);
        });
    }

    /**
     * Disconnects from Beet
     */
    disconnect() {
        this.socket.close();
        this.reset();
    }

    /**
     * Checks if Beet is connected
     *
     * @returns {boolean}
     */
    isConnected() {
        return this.connected;
    }

    inject(pointOfInjection) {
        if (this.identity.chain == "BTS") {
            if (!!pointOfInjection.prototype && !!pointOfInjection.prototype.get_type_operation) {
                // transaction builder
                return this.injectTransactionBuilder(pointOfInjection);
            }
        } else if (this.identity.chain == "STEEM") {
            if (!!pointOfInjection.broadcast) {
                return this.injectSteemLib(pointOfInjection);
            }
        }
        throw new Error("Unsupported point of injection")
    }

    injectTransactionBuilder(TransactionBuilder) {
        let sendRequest = this.sendRequest.bind(this);
        let _get_type_operation = TransactionBuilder.prototype.get_type_operation;
        TransactionBuilder.prototype.get_type_operation = function get_type_operation(name, payload) {
            if (!this.operations_to_send) {
                this.operations_to_send = [];
            }
            this.operations_to_send.push([name, payload]);
            return _get_type_operation.bind(this)(name, payload);
        };
        TransactionBuilder.prototype.add_signer = function add_signer(private_key, public_key) {
            if (typeof private_key !== "string" || !private_key || private_key !== "inject_wif") {
                throw new Error("Do not inject wif while using Beet")
            }
            if (!this.signer_public_keys) {
                this.signer_public_keys = [];
            }
            this.signer_public_keys.push(public_key);
        };
        TransactionBuilder.prototype.sign = function sign(chain_id = null) {
            // do nothing, wait for broadcast
            if (!this.tr_buffer) {
                throw new Error("not finalized");
            }
            if (this.signed) {
                throw new Error("already signed");
            }
            if (!this.signer_public_keys.length) {
                throw new Error(
                    "Transaction was not signed. Do you have a private key? [no_signers]"
                );
            }
            this.signed = true;
        };
        let send_to_beet = function sendToBeet(builder) {
            console.log(builder);
            return new Promise((resolve, reject) => {
                if (builder.operations_to_send.length != builder.operations.length) {
                    throw "Serialized and constructed operation count differs"
                }
                let args = ["signAndBroadcast", builder.ref_block_num, builder.ref_block_prefix, builder.expiration, builder.operations_to_send, builder.signer_public_keys];
                sendRequest('api', {
                    method: 'injectedCall',
                    params: args
                }).then((result) => {
                    resolve(result);
                }).catch((err) => {
                    reject(err);
                });
            });
        };
        TransactionBuilder.prototype.broadcast = function broadcast(was_broadcast_callback) {
            return  new Promise((resolve, reject) => {
                // forward to beet
                send_to_beet(this).then(
                    result => {
                        if (!!was_broadcast_callback) {
                            was_broadcast_callback();
                        }
                        resolve(result);
                    }
                ).catch(err => {
                    reject(err);
                });
            });
        }
        return TransactionBuilder;
    }

    injectSteemLib(steem) {
        let sendRequest = this.sendRequest.bind(this);
        Object.getOwnPropertyNames(steem.broadcast).forEach((operationName) => {
            if (!operationName.startsWith("_")) {
                let injectedCall = function () {
                    let args = Array.prototype.slice.call(arguments);
                    // last argument is always callback
                    let callback = args.pop();
                    // first argument will be operation name
                    args.unshift(operationName);
                    sendRequest('api', {
                        method: 'injectedCall',
                        params: args
                    }).then((result) => {
                        callback(null, result);
                    }).catch((err) => {
                        callback(err, null);
                    });
                };
                steem.broadcast[operationName] = injectedCall;
            }
        });
        return steem;
    }

    /* API Requests :

       The following should be split into chain-specific modules as multi-chain support is finalised
       These are currently BTS only.

    */

    /**
     * Gets the currently linked account
     *
     * @returns {Promise} Resolving is done by Beet
     */
    getAccount() {
        return new Promise((resolve, reject) => {
            return this.sendRequest('api', {
                method: 'getAccount',
                params: {}
            }).then(result => {
                resolve(JSON.parse(result));
            }).catch(err => {
                reject(err);
            });
        })

    }

    /**
     * Requests a signature for an arbitrary transaction
     *
     * @param {dict} payload
     * @returns {Promise} Resolving is done by Beet
     */
    requestSignature(payload) {
        return this.sendRequest('api', {
            method: 'requestSignature',
            params: payload
        });
    }

    /**
     * Requests a vote for specified votable object
     *
     * @param payload
     * @returns {Promise} Resolving is done by Beet
     */
    voteFor(payload) {
        return this.sendRequest('api', {
            method: 'voteFor',
            params: payload
        });
    }

    /**
     * Requests to execute a library call for the linked chain
     *
     * @param payload
     * @returns {Promise} Resolving is done by Beet
     */
    injectedCall(payload) {
        return this.sendRequest('api', {
            method: 'injectedCall',
            params: payload
        });
    }

    /**
     * Request a signed message with the given text in the common beet format
     *
     * @param text
     * @returns {Promise} Resolving is done by Beet
     */
    signMessage(text) {
        return new Promise((resolve, reject) => {
            this.sendRequest('api', {
                method: 'signMessage',
                params: text
            }).then(message => {
                message = JSON.parse(message);
                resolve(message);
            }).catch(err => {
                reject(err);
            });
        })
    }

    /**
     * Requests to verify a signed message with the given text in the common beet format
     *
     * @param text
     * @returns {Promise} Resolving is done by Beet
     */
    verifyMessage(signedMessage) {
        return new Promise((resolve, reject) => {
            this.sendRequest('api', {
                method: 'verifyMessage',
                params: signedMessage
            }).then(result => {
                resolve(result);
            }).catch(err => {
                reject(err);
            });
        })
    }
}

class Holder {
    constructor(_companion) {
        this.beet = _companion;
    }
}
let holder = new Holder(new BeetJS());
if (typeof window !== 'undefined') window.beet = holder.beet;

export default holder;