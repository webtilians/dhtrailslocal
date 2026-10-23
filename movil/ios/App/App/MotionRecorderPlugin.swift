import Foundation
import Capacitor
import CoreMotion

// The phone's other sensors, recorded with the GPS while a ride is recorded (Grabar): the accelerometer and
// the gyroscope about 100 times a second and the barometer, written by this side straight to a file («DHS1»,
// backend/app/sensors.py says how), which it uploads with the ride. With the screen locked they keep coming
// while the GPS records in the background. The same calls as on Android.
@objc(MotionRecorderPlugin)
public class MotionRecorderPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MotionRecorderPlugin"
    public let jsName = "MotionRecorder"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "upload", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "discard", returnType: CAPPluginReturnPromise)
    ]
    private let motionManager = CMMotionManager()
    private let altimeter = CMAltimeter()
    private let queue: OperationQueue = {
        let q = OperationQueue()
        q.maxConcurrentOperationCount = 1   // one writer
        q.name = "dhtrails-sensores"
        return q
    }()
    private var handle: FileHandle?
    private var buffer = Data()
    private var start: Double = 0           // ms since 1970
    private var bootToWall: Double = 0      // s: wall clock of the phone's start (sensor times count from it)
    private var motion = 0, pressure = 0
    private var recording = false

    private var fileURL: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("sensores.dhs")
    }

    private func available() -> [String: Any] {
        ["accelerometer": motionManager.isDeviceMotionAvailable, "gyroscope": motionManager.isGyroAvailable,
         "barometer": CMAltimeter.isRelativeAltitudeAvailable()]
    }

    private func append<T>(_ value: T) {
        var v = value
        withUnsafeBytes(of: &v) { buffer.append(contentsOf: $0) }
    }

    private func scaled(_ value: Double, _ factor: Double) -> Int16 {
        Int16(max(-32767, min(32767, (value * factor).rounded())))
    }

    private func flush(force: Bool = false) {
        guard let handle = handle, force || buffer.count > 1 << 16 else { return }
        handle.write(buffer)
        buffer.removeAll(keepingCapacity: true)
    }

    @objc func start(_ call: CAPPluginCall) {
        if recording { return call.resolve(available()) }
        guard motionManager.isDeviceMotionAvailable else { return call.reject("no accelerometer") }
        let hz = max(10, min(200, call.getInt("hz") ?? 100))
        let manager = FileManager.default
        try? manager.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        // A recording not saved yet (the app was closed) goes on in the same file, from its own start.
        let resume = (call.getBool("append") ?? false) && ((try? Data(contentsOf: fileURL))?.count ?? 0) >= 16
        if resume, let head = try? FileHandle(forReadingFrom: fileURL) {
            let bytes = head.readData(ofLength: 16)
            start = bytes.subdata(in: 8..<16).withUnsafeBytes { $0.loadUnaligned(as: Double.self) }
            try? head.close()
        } else {
            start = Date().timeIntervalSince1970 * 1000
            motion = 0
            pressure = 0
            manager.createFile(atPath: fileURL.path, contents: nil)
            buffer.removeAll()
            buffer.append(contentsOf: Array("DHS1".utf8) + [1, 0, 0, 0])
            append(start)
        }
        guard let handle = try? FileHandle(forWritingTo: fileURL) else { return call.reject("file") }
        handle.seekToEndOfFile()
        self.handle = handle
        bootToWall = Date().timeIntervalSince1970 - ProcessInfo.processInfo.systemUptime
        recording = true
        motionManager.deviceMotionUpdateInterval = 1.0 / Double(hz)
        motionManager.startDeviceMotionUpdates(to: queue) { [weak self] data, _ in
            guard let self = self, let m = data else { return }
            let t = (self.bootToWall + m.timestamp) * 1000 - self.start
            guard t >= 0 else { return }
            // Acceleration with gravity (as Android gives it), in m/s²; rotation in rad/s.
            let g = 9.80665
            let a = (m.gravity.x + m.userAcceleration.x, m.gravity.y + m.userAcceleration.y, m.gravity.z + m.userAcceleration.z)
            self.buffer.append(1)
            self.append(UInt32(t))
            for v in [a.0 * g, a.1 * g, a.2 * g] { self.append(self.scaled(v, 100)) }
            for v in [m.rotationRate.x, m.rotationRate.y, m.rotationRate.z] { self.append(self.scaled(v, 1000)) }
            self.motion += 1
            self.flush()
        }
        if CMAltimeter.isRelativeAltitudeAvailable() {
            altimeter.startRelativeAltitudeUpdates(to: queue) { [weak self] data, _ in
                guard let self = self, let d = data else { return }
                let t = (self.bootToWall + d.timestamp) * 1000 - self.start
                guard t >= 0 else { return }
                self.buffer.append(2)
                self.append(UInt32(t))
                self.append(Float(d.pressure.doubleValue * 10))   // kPa → hPa
                self.pressure += 1
            }
        }
        call.resolve(available())
    }

    private func halt() {
        guard recording else { return }
        recording = false
        motionManager.stopDeviceMotionUpdates()
        altimeter.stopRelativeAltitudeUpdates()
        queue.waitUntilAllOperationsAreFinished()
        queue.addOperation { self.flush(force: true) }
        queue.waitUntilAllOperationsAreFinished()
        try? handle?.close()
        handle = nil
    }

    @objc func stop(_ call: CAPPluginCall) {
        halt()
        let size = (try? FileManager.default.attributesOfItem(atPath: fileURL.path))?[.size] as? Int ?? 0
        call.resolve(["motion": motion, "pressure": pressure, "bytes": size])
    }

    // The file, deflated, to the server with the rider's session (POST multipart, field «file»).
    @objc func upload(_ call: CAPPluginCall) {
        guard let urlText = call.getString("url"), let url = URL(string: urlText), let token = call.getString("token") else {
            return call.reject("nothing to upload")
        }
        halt()
        guard let raw = try? Data(contentsOf: fileURL), let packed = try? (raw as NSData).compressed(using: .zlib) as Data else {
            return call.reject("nothing to upload")
        }
        let boundary = "dhtrails\(UInt64(Date().timeIntervalSince1970 * 1000))"
        var body = Data()
        body.append(("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"sensores.dhs\"\r\n" +
            "Content-Type: application/octet-stream\r\n\r\n").data(using: .utf8)!)
        body.append(packed)
        body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        URLSession.shared.uploadTask(with: request, from: body) { _, response, error in
            if error != nil { return call.reject("upload failed") }
            call.resolve(["status": (response as? HTTPURLResponse)?.statusCode ?? 0])
        }.resume()
    }

    @objc func discard(_ call: CAPPluginCall) {
        halt()
        try? FileManager.default.removeItem(at: fileURL)
        motion = 0
        pressure = 0
        call.resolve()
    }
}
