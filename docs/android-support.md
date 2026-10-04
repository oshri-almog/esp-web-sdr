# Android support (WebUSB)

ESP-WebSDR and the firmware installer now work in Chrome on Android. The
board connects to the phone with a USB OTG cable or adapter. On computers,
nothing changes.

## The problem

Both pages talk to the board through the Web Serial API (`navigator.serial`).
Chrome on Android gained Web Serial only in 2026 (Chrome 148 beta, targeted
for 149). It covers Bluetooth serial and, on a limited set of devices, USB
serial through Android's own serial API
([blink-dev PSA](https://groups.google.com/a/chromium.org/g/blink-dev/c/yGhvQ6mEmcY),
[Notebookcheck](https://www.notebookcheck.net/Chrome-148-Beta-for-Android-adds-Web-Serial-SharedWorker-support.1269721.0.html)).
On most phones, a USB ESP32 board never shows up in the port picker, so the
pages could not connect.

Chrome on Android has supported **WebUSB** (`navigator.usb`) since version 61.
WebUSB gives the page raw access to a USB device. It works on Android because
no OS serial driver owns the device there. On Windows, macOS and Linux the OS
driver claims the device, so WebUSB cannot use it and Web Serial stays the
right API.

## The solution

[`usb-serial.js`](../usb-serial.js) is a WebUSB serial driver. It exposes
the same interface as a Web Serial port, so `radio.js` and esptool-js use it
without changes to their protocol code.

### Choosing the API

`serialApi()` picks the backend:

| Browser | Backend |
| --- | --- |
| Android, with WebUSB | WebUSB driver (even if `navigator.serial` exists) |
| Has WebUSB but no Web Serial | WebUSB driver |
| Desktop Chrome / Edge | `navigator.serial`, unchanged |
| Neither API | `null`; the page explains which browsers work |

The page treats the browser as Android when `navigator.userAgentData.platform`
is `"Android"` or the user-agent string contains `Android`.

### Supported USB serial chips

| Chip | Detected by | Control protocol |
| --- | --- | --- |
| ESP native USB Serial/JTAG (C3, C5, C6, C61, H2, S3, S31) | CDC data interface (class 10) | CDC-ACM: `SET_LINE_CODING`, `SET_CONTROL_LINE_STATE`, `SEND_BREAK` |
| Other CDC-ACM devices: WCH CH9102/CH343, TinyUSB | CDC data interface | CDC-ACM |
| Silicon Labs CP210x | VID `0x10c4`, vendor interface | AN571: `IFC_ENABLE`, `SET_BAUDRATE`, `SET_LINE_CTL`, `SET_MHS` |
| WCH CH340/CH341 | VID `0x1a86`, vendor interface | Linux `ch341` init sequence and baud divisor |
| FTDI FT232R/FT231X/FT2232H, etc. | VID `0x0403` | `SIO_RESET`, latency timer, baud divisor, modem control; strips the 2 status bytes at the start of each USB packet |

On dual-channel FTDI bridges (FT2232H on ESP-Prog and some devkits), the
driver uses **channel B**, the UART; channel A is JTAG.

Prolific PL2303 bridges are not supported over WebUSB.

### How the port behaves

`UsbSerialPort` follows Web Serial semantics closely enough for both
consumers:

- **`readable`/`writable`:** these are recreated after a reader cancels or a
  writer closes, as in Web Serial. They return `null` when the port is
  closed. When the device is lost, `writable` returns `null` at once and
  `readable` returns `null` after any data already received has been read.
  esptool-js depends on this to stop its read loop.
- **Reading:** a port-level pump keeps 4 bulk IN transfers in flight
  (16 KiB each, the Android-safe request size), so 2 Mbaud streams do not
  overrun. Received data goes into a port-level queue, and the stream takes
  a chunk from it only when a read is pending. Data not yet read when a reader
  cancels stays in the queue, in order, for the next reader.
- **Writing:** writes are split into 16 KiB transfers.
- **Control lines:** `setSignals()` keeps the current DTR/RTS/break state.
  A partial update, such as `{requestToSend: true}`, therefore sends both lines
  in a single control request. That matters for the ESP auto-reset circuits.
- **Opening the port:** `open()` re-sends the last DTR/RTS state. This lets
  `radio.js` reopen the port at a new baud rate without resetting the board.
- **Changing the baud rate:** `setBaudRate()` changes the rate in place.
  esptool-js 0.7.0 uses it instead of closing and reopening the port, so the
  flasher reaches 2 Mbaud without re-claiming the USB device.
- **Unplugging:** the `navigator.usb` `disconnect` event, or a failed IN
  transfer, errors the open streams. `radio.js` then reports the disconnect as
  it does with Web Serial. A failed write rejects only that write.
- **Picking and reconnecting:** `requestPort()` filters the USB picker to the
  known vendors plus any CDC device. `getPorts()` returns the same port object
  for the same device, so "Connect to Last Device" and auto-connect work.

## Files changed

| File | Change |
| --- | --- |
| `usb-serial.js` | New WebUSB driver and `serialApi()` selector |
| `index.html`, `flash.html` | Load `usb-serial.js` before the page scripts |
| `app.js` | Port selection and auto-connect use `serialApi()` |
| `radio.js` | `connect()` uses `serialApi()` when no port is passed; it falls back to `navigator.serial` when loaded alone, as in tests |
| `flasher/app.js` | Uses `serialApi()` for support detection and `requestPort()` |
| `README.md`, `flash.html` | Mention Android with USB OTG |
| `tests/usb-serial.test.mjs` | New tests, listed below |
| `tests/port-selection.test.mjs` | Provides `serialApi` to the sandboxed `app.js` slice |

## Tests

`node --test tests/*.test.mjs` passes 118 tests: the 105 that existed before,
plus 13 new ones. The new tests run against a mock WebUSB device and cover:

- backend selection on Android, desktop, and browsers without either API;
- the CDC-ACM, CP210x, CH340 and FTDI request sequences, checked
  byte for byte;
- CH340 and FTDI baud divisors against known values, for example CH340
  115200 → `0xcc03` and FTDI 921600 → `0x8003`;
- FTDI status-byte stripping, and channel B on dual-channel chips;
- stream semantics: data order, unread data kept when a reader cancels
  (including data already received), close and reopen, and device loss;
- `radio.js` connecting and synchronizing over a WebUSB port;
- esptool-js `Transport` connecting, exchanging SLIP data, changing baud in
  place, and disconnecting over a WebUSB port.

It was also confirmed working in Chrome on an Android phone, using the LAN
setup below.

## Trying it from a phone on your LAN

WebUSB requires a secure context: HTTPS or `localhost`. For local testing:

1. On the computer, serve the repository on the LAN:
   ```sh
   python -m http.server 8080 --bind 0.0.0.0
   ```
2. On the phone, open
   `chrome://flags/#unsafely-treat-insecure-origin-as-secure`. Add
   `http://<computer-ip>:8080`, set it to **Enabled**, and relaunch Chrome.
3. Open `http://<computer-ip>:8080/`. Connect the board with a USB OTG cable
   or adapter and select **Connect ESP-SDR**.

If the phone cannot load the page, allow Python through the computer's
firewall on private networks. A site served over HTTPS, such as GitHub Pages,
needs none of these steps.

## Known limitations

- Prolific PL2303 adapters are not supported on Android.
- If Chrome's "Desktop site" mode hides the Android user agent, the page may
  fall back to Web Serial. On most phones, Web Serial does not list USB
  devices.
- The phone powers the board through OTG. Some phones cannot supply enough
  current for every board.
- If another Android app has claimed the device, opening the port fails with
  a message asking to close that app or to unplug and replug the board.
