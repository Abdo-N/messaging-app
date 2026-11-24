export class RollingCounter {
  constructor(windowMs = 10000) {
    this.windowMs = windowMs;
    this.stamps = [];
  } // A window that slides over 10 seconds 

  prune(now) {
    while (this.stamps.length > 0 && this.stamps[0] < now - this.windowMs) {
      this.stamps.shift();
    }
  }//updating our window that messages before 10 sec is removed

  record(now = Date.now()) { //Date.now() turn the time to ms 
    this.stamps.push(now);
    this.prune(now);
  }//pushing a sended message in the stamp 

  perSecond(now = Date.now()) {
    this.prune(now);
    return this.stamps.length / (this.windowMs / 1000);
  } //returning in format of (e.g 5 msg/sec )
}

const messageRate = new RollingCounter();

const restRate = new RollingCounter();
const restBytes = { in: 0, out: 0 };

const online = new Map(); // Map is Like a table we access a certin row a id 

const startTime = Date.now();

let active = 0; //total active user
const totals = { socket: 0, rest: 0 }; //total message per protocol

function uptimeSeconds(now = Date.now()) {
  return Math.floor((now - startTime) / 1000);
} //time since the server started (not exported not used by others)


export function socketConnected(user) {
  active += 1; //incremint active connections
  if (!user) return;
  const entry = online.get(user.id) || { username: user.username, sockets: 0 }; //use existing row of that user in the map if not found create one
  entry.sockets += 1; //incremint sockets of the user (same user can open connection from diffrent devices)
  online.set(user.id, entry);//update the map 
}

export function socketDisconnected(user) {
  active = Math.max(0, active - 1); //decremint active connections (cant be 0)
  if (!user) return;
  const entry = online.get(user.id); //use existing row of that user in the map
  if (!entry) return; 
  entry.sockets -= 1;
  if (entry.sockets <= 0) online.delete(user.id);//if 0 or less delete
}

export function messageStored(protocol) {
  if (protocol !== 'socket' && protocol !== 'rest') return;
  totals[protocol] += 1;
  messageRate.record();
} //call when a message sent to calc the msg/sec and total msg per protocol


export function restRequest(bytesIn, bytesOut) {
  restBytes.in += Number(bytesIn) || 0; // Number(bytesIn) turn bytesIn to number and if fails return 0 
  restBytes.out += Number(bytesOut) || 0;
  restRate.record(); //save the restRequest so we can retrun in snapshot() the msg/sec using perSecond()
}


export function snapshot() {
  return {
    active_connections: active,
    messages: {
      socket: totals.socket,
      rest: totals.rest,
      total: totals.socket + totals.rest,
    },
    messages_per_sec: messageRate.perSecond(),
    rest_requests_per_sec: restRate.perSecond(),
    rest_bytes: { in: restBytes.in, out: restBytes.out },
    uptime_s: uptimeSeconds(),
    online_users: [...online].map(([id, e]) => ({ id, username: e.username })),
  };
} //returning our metrics values

export function startConsoleSummary(everyMs = 5000) {
  const timer = setInterval(() => {
    const s = snapshot();
    console.log(
      `[metrics] conn=${s.active_connections} users=${s.online_users.length} ` +
      `msgs=${s.messages.total} ${s.messages_per_sec}/s up=${s.uptime_s}s`
    );
  }, everyMs);
  timer.unref(); //does not stop after 5 sec , runs as long as the function calling it is runing 
}//sending a summary every 5 sec