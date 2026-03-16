import * as net from 'net';

let server = net.createServer({
    pauseOnConnect: true // Required by `TCPConn`
});




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

// The cutMessage() function tests if the message is complete using the delimiter '\n'.
function cutMessage(buf: DynBuf): null | Buffer {
    // messages are separated by '\n'
    const idx = buf.data.subarray(0, buf.length).indexOf('\n');
    if(idx < 0){
        return null; // Not complete
    }
    // buf.subarray() returns reference of a subarray without copying.
    // Buffer.from() creates a new buffer by copying the data from the source.
    const msg = Buffer.from(buf.data.subarray(0, idx + 1));
    bufPop(buf, idx + 1);
    return msg;
}

// Creating a wrapper from net.Socket

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
    console.log("new connection", socket.remoteAddress, socket.remotePort);

    try {
        await serveClient(socket);
    } catch (err) {
        console.error(`Exception: `, err)
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

async function serveClient(socket: net.Socket): Promise<void> {
    const conn: TCPConn = soInit(socket);
    const buf: DynBuf = {data: Buffer.alloc(0), length: 0};
    while(true){
        // Try to get 1 message from the buffer
        // checks the buffer before reading more data. important because a single soRead might deliver multiple messages at once
        const msg = cutMessage(buf);
        if(!msg){
            // pushes data into the buffer, checks for EOF, then continues back to try cutMessage again
            const data: Buffer = await soRead(conn);
            bufPush(buf, data);
            if(data.length === 0){
                console.log(`end connection`);
                break;
            }
            continue;
            
        }  
        if(msg.equals(Buffer.from('quit\n')) || msg.equals(Buffer.from('quit\r\n'))){
            await soWrite(conn, Buffer.from('Bye.\n'));
            socket.destroy();
            return;
        }else{
            const reply = Buffer.concat([Buffer.from('Echo: '), msg])
            await soWrite(conn, reply);
        }
        
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