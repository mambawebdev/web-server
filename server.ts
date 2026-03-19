import * as net from 'net';

let server = net.createServer({
    pauseOnConnect: true // Required by `TCPConn`
});
class HTTPError extends Error{
    code: number
    constructor(code: number, message: string){
        super(message);
        this.code = code;
    }
}

// Simple string to int conversion

function parseDec(str: string): number {
    return parseInt(str.trim(), 10);
}

function readerFromMemory(data: Buffer): BodyReader {
    let done = false;
    return {
        length: data.length,
        read: async (): Promise<Buffer> => {
            if(done){
                return Buffer.from(''); // EOF
            }   
            done = true;
            return data;
        }
    }
}

// Define the structure for HTTP message based on understanding of HTTP semantics

// A parsed HTTP request header

type HTTPReq = {
    method: string,
    uri: Buffer,
    version: string,
    headers: Buffer[],
}

// An HTTP Response

type HTTPRes = {
    code: number,
    headers: Buffer[],
    body: BodyReader,
}

// An interface for reading / writing data from/to HTTP body.

type BodyReader = {
    // the "content-length", -1 if unknown
    length: number,
    // read data, returns an empty buffer after EOF.
    read: () => Promise<Buffer>
}

type TCPConn = {
    // the JS socket object
    socket: net.Socket;
    // From the 'error' event
    err: null | Error;
    // EOF from the 'end' event
    ended: boolean;   
    // the callbacks of the promise of the current read
    reader: null | {
        resolve: (value: Buffer) => void;
        reject: (reason: Error) => void;
    }
}
// -------------Coding a Dynamic Buffer ------------
// A dynamic-sized buffer

type DynBuf = {
    data: Buffer,
    length: number
}

// Append data to DynBuf

// function bufPush(buf: DynBuf, data: Buffer): void{
//     const newLen = buf.length = data.length;
//     if(buf.data.length < newLen){
//         // grow the capacity...
//     }

//     data.copy(buf.data, buf.length, 0);
//     buf.length = newLen;
// }


/* 
Chapter 5
✅ DynBuf type with data and length
✅ bufPush grows capacity by powers of two
✅ bufPop uses copyWithin to shift data left
✅ cutMessage correctly finds \n, extracts the message, and pops it from the buffer
✅ serveClient loops — tries to cut a message first, only reads more data if needed
✅ Handles quit\n to cleanly close the connection
✅ Echoes messages back with Echo:  prefix

*/



// buf.copyWithin(dst, src_start, src_end) copies data within a buffer, source and destination can overlap
function bufPop(buf: DynBuf, len: number): void{
    buf.data.copyWithin(0, len, buf.length);
    buf.length -= len;
}

function bufPush(buf: DynBuf, data: Buffer): void {
    const newLen = buf.length + data.length;
    if(buf.data.length < newLen){
        // grow the capacity by the power of two
        let cap = Math.max(buf.data.length, 32);
        while(cap < newLen){
            cap *= 2;
        }

        const grown = Buffer.alloc(cap);
        buf.data.copy(grown, 0, 0);
        buf.data = grown;
    }
    data.copy(buf.data, buf.length, 0);
    buf.length = newLen;
}


/* Chapter 6 */

// Creating functions to splitLines(), parseRequestLine() and validateHeader() as per RFC

// Splits a buffer into lines using CRLF as the delimiter
function splitLines(data: Buffer): Buffer[]{
    const lines: Buffer[] = [];
    let start = 0;

    for(let i = 0; i < data.length - 1; i++){
        // Look for \r\n (13 = \r, 10 = \n)
        if(data[i] === 13 && data[i + 1] === 10){
            lines.push(data.subarray(start, i));
            start = i + 2; // Skip past the \r\n
        }
    }

    lines.push(data.subarray(start));
    return lines;
}

// Parses "METHOD URI VERSION" from the first line of an HTTP request
function parseRequestLine(line: Buffer): [string, Buffer, string] {

    const text = line.toString('latin1');

    const parts = text.split(' ');

    if(parts.length !== 3){
        throw new HTTPError(400, 'bad request line');
    }

    const [method, uri, version] = parts;

    // Validate HTTP version format
    if(!version.startsWith('HTTP/')){
        throw new HTTPError(400, 'bad HTTP version');
    }

    return [method, Buffer.from(uri), version.trim()];
}

// Validates the header line follows the "Name: value" formatting
function validateHeader(h: Buffer): boolean{
    const text = h.toString('latin1');
    const colonIdx = text.indexOf(":");

    // Must have a colon, and the name part cannot be empty
    if(colonIdx <= 0){
        return false;
    }

    // Header name cannot contain spaces (per HTTP specification)
    const name = text.substring(0, colonIdx);
    if(name.includes(" ")){
        return false;
    }
    return true;
}

function fieldGet(headers: Buffer[], key: string): null | Buffer{
    const lowerKey = key.toLowerCase();
    for(const header of headers){
        const text = header.toString('latin1');
        const colonIdx = text.indexOf(":");
        if(colonIdx > 0){
            const name = text.substring(0, colonIdx).trim().toLowerCase();
            if(name === lowerKey){
                return Buffer.from(text.substring(colonIdx + 1).trim());
            }
        }
    }
    return null;
}

// BodyReader from a socket with a known length

function readerFromConnLength(conn: TCPConn, buf: DynBuf, remain: number): BodyReader{
    return {
        // The remain variable is a state captured by the read() function to keep track of the remaining body length.
        length: remain,
        read: async (): Promise<Buffer> => {
            if(remain === 0){
                return Buffer.from(''); // Done
            }
            if(buf.length === 0){
                // Try to get some data if there is none
                const data = await soRead(conn);
                bufPush(buf, data);
                if(data.length === 0){
                    // Expect more data!
                    throw new Error('Unexpected EOF from HTTP body');
                }
            }
            // Consume datga from the buffer
            const consume = Math.min(buf.length, remain)
            remain -= consume;
            const data = Buffer.from(buf.data.subarray(0, consume));
            bufPop(buf, consume);
            return data;
        }
    }
}


function readerFromReq(conn: TCPConn, buf: DynBuf, req: HTTPReq): BodyReader {
    let bodyLen = -1;
    const contentLen = fieldGet(req.headers, 'Content-Length');
    if(contentLen){
        bodyLen = parseDec(contentLen.toString('latin1'));
        if(isNaN(bodyLen)){
            throw new HTTPError(400, 'bad Content-Length');
        }
    }

    const bodyAllowed = !(req.method === "GET" || req.method === "HEAD");
    const chunked = fieldGet(req.headers, 'Transfer-Encoding')?.equals(Buffer.from('chunked')) || false;
    if(!bodyAllowed && (bodyLen > 0 || chunked)){
        throw new HTTPError(400, 'HTTP body not allowed.')
    }
    if(!bodyAllowed){
        bodyLen = 0;
    }

    if(bodyLen >= 0){
        // "Content-Length" is present

        return readerFromConnLength(conn, buf, bodyLen);
    }else if(chunked){
        // Chunked encoding
        throw new HTTPError(401, 'TODO');
    }else{
        // read the rest of the connection
        throw new HTTPError(501, 'TODO');
    }
}


// Parse an HTTP request header
function parseHTTPReq(data: Buffer): HTTPReq {
    // Split the data into lines
    // takes the full raw header buffer and splits it into an array of lines using \r\n as the separator.
    const lines: Buffer[] = splitLines(data); 
    // The first line is `METHOD URI VERSION`
    //  takes the first line like GET /index.html HTTP/1.1 and returns the 3 parts: method, uri, version
    const [method, uri, version] = parseRequestLine(lines[0]);
    // Followed by the header fields in the format of `Name: value`
    //  checks that a header line like Content-Type: text/html is properly formatted (has a colon separating name and value).
    const headers: Buffer[] = [];
    for (let i = 1; i < lines.length - 1; i++){
        const h = Buffer.from(lines[i]); // Copy
        if(!validateHeader(h)){
            throw new HTTPError(400, 'bad field');
        }
        headers.push(h);
    }
    console.assert(lines[lines.length - 1].length === 0);
    return {
        method: method,
        uri: uri,
        version: version,
        headers: headers
    }
}



// The maximum length of an HTTP header
const kMaxHeaderLen = 1024 * 8;

// Parse and remove teh header from the beginning of the buffer if possible
// The cutMessage() function tests if the message is complete using the delimiter '\n'.
function cutMessage(buf: DynBuf): null | HTTPReq {
    // messages are separated by '\n'
    const idx = buf.data.subarray(0, buf.length).indexOf('\r\n\r\n');
    if(idx < 0){
        if(buf.length >= kMaxHeaderLen){
            throw new HTTPError(413, 'header is too large');
        }
        return null;
    }
    // buf.subarray() returns reference of a subarray without copying.
    // Buffer.from() creates a new buffer by copying the data from the source.
    // const msg = Buffer.from(buf.data.subarray(0, idx + 1));
    // bufPop(buf, idx + 1);

    // Parse and remove header
    const msg = parseHTTPReq(buf.data.subarray(0, idx + 4))
    bufPop(buf, idx + 4);
    return msg;
}

// Creating a wrapper from net.Socket
// <!-- NOTE: npx tsx server.ts -->

function soInit(socket: net.Socket): TCPConn {
    const conn: TCPConn = {
        socket: socket,
        err: null,
        ended: false,
        reader: null,
    }
    socket.on('data', (data: Buffer) => {
        console.assert(conn.reader);
        // Pause the data event
        conn.socket.pause();
        // fullfill the promise of the current read
        conn.reader!.resolve(data);
        conn.reader = null;
    })
    socket.on('end', () => {
        // this will also fulfill the current read
        conn.ended = true;
        if(conn.reader){
            conn.reader.resolve(Buffer.from(''));
            conn.reader = null;
        }
    })
    socket.on('error', (err: Error) => {
        // errors will also be delivered to the current read.
        conn.err = err;
        if(conn.reader){
            conn.reader.reject(err);
            conn.reader = null;
        }
    })
    return conn;
}

// returns an empty `Buffer` after EOF

function soRead(conn: TCPConn): Promise<Buffer> {
    console.assert(!conn.reader)
    return new Promise((resolve, reject) => {
        // If connection is not readable, complete the promise now.
        if(conn.err){
            reject(conn.err);
            return;
        }

        if(conn.ended){
            resolve(Buffer.from('')) // EOF
            return;
        }

        // save the promise callbacks
        conn.reader = {
            resolve: resolve,
            reject: reject
        }

        // and resume the 'data' event to fulfill the promise later.
        conn.socket.resume();

    })
}

function soWrite(conn: TCPConn, data: Buffer): Promise<void> {
    console.assert(data.length > 0);
    return new Promise((resolve, reject) => {
        if(conn.err){
            reject(conn.err);
            return;
        }

        conn.socket.write(data, (err?: Error | null) => {
            if(err){
                reject(err);
            }else{
                resolve();
            }
        })
    })
}

// A promise-based API for TCP sockets


const newConn = async (socket: net.Socket) => {
    const conn: TCPConn = soInit(socket);
    try {
        await serveClient(socket);
    } catch (err) {
        console.error(`Exception: `, err)
        if(err instanceof HTTPError){
            // Intended to send an error response
            const resp: HTTPRes = {
                code: err.code,
                headers: [],
                body: readerFromMemory(Buffer.from(err.message + "\n"))
            }
        }
        try{
            await writeHTTPResp(conn, resp);
        }catch(err){
            /* IGNORE */
        }
    }finally{
        socket.destroy();
    }

    // socket.on('end', () => {
    //     // FIN received. The connection will be closed automatically.
    //     console.log('EOF.');
    // })

    // socket.on('data', (data: Buffer) => {
    //     console.log('data: ', data);
    //     socket.write(data); // Echo back teh data

    //     // Actively close tehe connection if the data includes 'q'
    //     if(data.includes('q')){
    //         console.log('closing...');
    //         socket.end(); // This will send FIN and close the connection
    //     }
    // })

    // socket.on('error', (err: Error) => {
    //     console.log('socket error:', err.message);
    // });
}

async function handleReq(req: HTTPReq, body: BodyReader): Promise<HTTPRes> {
    // Act on the request URI
    let resp: BodyReader;
    switch(req.uri.toString('latin1')){
        case "/echo":
            // HTTP echo server
            resp = body;
            break;
        default:
            resp = readerFromMemory(Buffer.from('hello world.\n'))
            break;    
    }

    return{
        code: 200,
        headers: [Buffer.from('Server: my_first_http_server')],
        body: resp
    }

    
}

async function serveClient(socket: net.Socket): Promise<void> {
    const conn: TCPConn = soInit(socket);
    const buf: DynBuf = {data: Buffer.alloc(0), length: 0};
    while(true){
        // Try to get 1 message from the buffer
        // checks the buffer before reading more data. important because a single soRead might deliver multiple messages at once
        const msg: null | HTTPReq = cutMessage(buf);
        if(!msg){
            // pushes data into the buffer, checks for EOF, then continues back to try cutMessage again
            const data: Buffer = await soRead(conn);
            bufPush(buf, data);
            if(data.length === 0 && buf.length === 0){
                return;
            }
            if(data.length === 0){
                throw new HTTPError(400, 'Unexpected EOF.')
            }
            continue;
        } 
        // Process the message and send the response 
        const reqBody: BodyReader = readerFromReq(conn, buf, msg);
        const res: HTTPRes = await handleReq(msg, reqBody);
        await writeHTTPResp(conn, res);
        // close the connection for HTTP/1.0
        if(msg.version === '1.0'){
            return;
        }
        while((await reqBody.read()).length > 0) {/* Empty */}
        
    }
}

server.on('error', (err: Error) => {
    throw err;
})

server.on('connection', newConn);

server.listen({
    host: `127.0.0.1`,
    port: 1234
})