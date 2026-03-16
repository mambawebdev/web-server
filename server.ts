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
        reject: (reason: Buffer) => void;
    }
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

        conn.socket.write(data, (err?: Error) => {
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
    while(true){
        const data = await soRead(conn);
        if(data.length === 0){
            console.log(`end connection`);
            break;
        }

        console.log("data: ", data)
        await soWrite(conn, data);
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