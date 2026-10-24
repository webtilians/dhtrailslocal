package es.dhtrails.app;

import android.content.Context;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.PowerManager;
import android.os.SystemClock;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.zip.GZIPOutputStream;

// The phone's other sensors, recorded with the GPS while a ride is recorded (Grabar): the accelerometer and
// the gyroscope about 100 times a second and the barometer when there is one, written by this side straight
// to a file («DHS1», backend/app/sensors.py says how), which it uploads with the ride. The screen can be off:
// the GPS's service keeps the app alive and a wake lock keeps the processor reading.
@CapacitorPlugin(name = "MotionRecorder")
public class MotionRecorderPlugin extends Plugin implements SensorEventListener {
    private static final byte MOTION = 1, PRESSURE = 2;
    private SensorManager manager;
    private HandlerThread thread;
    private OutputStream out;
    private PowerManager.WakeLock wake;
    private long start, bootToWallMs, motion, pressure;
    private final float[] rotation = new float[3];
    private final ByteBuffer record = ByteBuffer.allocate(17).order(ByteOrder.LITTLE_ENDIAN);

    private File file() {
        return new File(getContext().getFilesDir(), "sensores.dhs");
    }

    private static short scaled(float value, float factor) {
        return (short) Math.max(-32767, Math.min(32767, Math.round(value * factor)));
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (thread != null) {
            call.resolve(available());
            return;
        }
        manager = (SensorManager) getContext().getSystemService(Context.SENSOR_SERVICE);
        Sensor accel = manager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER);
        if (accel == null) {
            call.reject("no accelerometer");
            return;
        }
        int hz = Math.max(10, Math.min(200, call.getInt("hz", 100)));
        try {
            // A recording not saved yet (the app was closed) goes on in the same file, from its own start.
            File f = file();
            boolean append = Boolean.TRUE.equals(call.getBoolean("append", false)) && f.length() >= 16;
            if (append) {
                try (RandomAccessFile old = new RandomAccessFile(f, "r")) {
                    byte[] head = new byte[16];
                    old.readFully(head);
                    start = (long) ByteBuffer.wrap(head, 8, 8).order(ByteOrder.LITTLE_ENDIAN).getDouble();
                }
            } else {
                start = System.currentTimeMillis();
                motion = pressure = 0;
            }
            out = new BufferedOutputStream(new FileOutputStream(f, append), 1 << 16);
            if (!append) {
                ByteBuffer head = ByteBuffer.allocate(16).order(ByteOrder.LITTLE_ENDIAN);
                head.put(new byte[] {'D', 'H', 'S', '1', 1, 0, 0, 0}).putDouble(start);
                out.write(head.array());
            }
        } catch (Exception e) {
            call.reject("file");
            return;
        }
        // Sensor times count from the phone's start: to the wall clock, as the GPS's are.
        bootToWallMs = System.currentTimeMillis() - SystemClock.elapsedRealtimeNanos() / 1_000_000;
        thread = new HandlerThread("dhtrails-sensores");
        thread.start();
        Handler handler = new Handler(thread.getLooper());
        int period = 1_000_000 / hz;
        manager.registerListener(this, accel, period, handler);
        Sensor gyro = manager.getDefaultSensor(Sensor.TYPE_GYROSCOPE);
        if (gyro != null) manager.registerListener(this, gyro, period, handler);
        Sensor baro = manager.getDefaultSensor(Sensor.TYPE_PRESSURE);
        if (baro != null) manager.registerListener(this, baro, 100_000, handler);
        PowerManager power = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        wake = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "dhtrails:sensores");
        wake.acquire(12 * 60 * 60 * 1000L);
        call.resolve(available());
    }

    private JSObject available() {
        JSObject result = new JSObject();
        result.put("accelerometer", manager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER) != null);
        result.put("gyroscope", manager.getDefaultSensor(Sensor.TYPE_GYROSCOPE) != null);
        result.put("barometer", manager.getDefaultSensor(Sensor.TYPE_PRESSURE) != null);
        return result;
    }

    // On the sensors' own thread: the only one that writes.
    @Override
    public void onSensorChanged(SensorEvent event) {
        long t = bootToWallMs + event.timestamp / 1_000_000 - start;
        if (t < 0 || out == null) return;
        int type = event.sensor.getType();
        try {
            if (type == Sensor.TYPE_GYROSCOPE) {
                System.arraycopy(event.values, 0, rotation, 0, 3);
            } else if (type == Sensor.TYPE_ACCELEROMETER) {
                record.clear();
                record.put(MOTION).putInt((int) t)
                    .putShort(scaled(event.values[0], 100)).putShort(scaled(event.values[1], 100)).putShort(scaled(event.values[2], 100))
                    .putShort(scaled(rotation[0], 1000)).putShort(scaled(rotation[1], 1000)).putShort(scaled(rotation[2], 1000));
                out.write(record.array(), 0, 17);
                motion++;
            } else if (type == Sensor.TYPE_PRESSURE) {
                record.clear();
                record.put(PRESSURE).putInt((int) t).putFloat(event.values[0]);
                out.write(record.array(), 0, 9);
                pressure++;
            }
        } catch (Exception ignored) {
        }
    }

    @Override
    public void onAccuracyChanged(Sensor sensor, int accuracy) {}

    private void halt() {
        if (thread == null) return;
        manager.unregisterListener(this);
        CountDownLatch closed = new CountDownLatch(1);
        new Handler(thread.getLooper()).post(() -> {
            try {
                out.close();
            } catch (Exception ignored) {
            }
            out = null;
            closed.countDown();
        });
        try {
            closed.await(3, TimeUnit.SECONDS);
        } catch (InterruptedException ignored) {
        }
        thread.quitSafely();
        thread = null;
        if (wake != null && wake.isHeld()) wake.release();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        halt();
        JSObject result = new JSObject();
        result.put("motion", motion);
        result.put("pressure", pressure);
        result.put("bytes", file().length());
        call.resolve(result);
    }

    // The file, gzipped, to the server with the rider's session (POST multipart, field «file»).
    @PluginMethod
    public void upload(PluginCall call) {
        String url = call.getString("url"), token = call.getString("token");
        File f = file();
        if (url == null || token == null || !f.isFile()) {
            call.reject("nothing to upload");
            return;
        }
        halt();
        new Thread(() -> {
            HttpURLConnection http = null;
            try {
                String boundary = "dhtrails" + System.nanoTime();
                http = (HttpURLConnection) new URL(url).openConnection();
                http.setDoOutput(true);
                http.setRequestMethod("POST");
                http.setChunkedStreamingMode(1 << 16);
                http.setRequestProperty("Authorization", "Bearer " + token);
                http.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);
                try (OutputStream body = http.getOutputStream(); InputStream in = new FileInputStream(f)) {
                    body.write(("--" + boundary + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"sensores.dhs\"\r\n" +
                        "Content-Type: application/octet-stream\r\n\r\n").getBytes("UTF-8"));
                    GZIPOutputStream zip = new GZIPOutputStream(new NonClosing(body), 1 << 16);
                    byte[] buffer = new byte[1 << 16];
                    int n;
                    while ((n = in.read(buffer)) > 0) zip.write(buffer, 0, n);
                    zip.finish();
                    body.write(("\r\n--" + boundary + "--\r\n").getBytes("UTF-8"));
                }
                int code = http.getResponseCode();
                JSObject result = new JSObject();
                result.put("status", code);
                call.resolve(result);
            } catch (Exception e) {
                call.reject("upload failed");
            } finally {
                if (http != null) http.disconnect();
            }
        }).start();
    }

    @PluginMethod
    public void discard(PluginCall call) {
        halt();
        file().delete();
        motion = pressure = 0;
        call.resolve();
    }

    // The request's body stays open after the compressed part, for the closing boundary.
    private static class NonClosing extends java.io.FilterOutputStream {
        NonClosing(OutputStream out) {
            super(out);
        }

        @Override
        public void write(byte[] b, int off, int len) throws java.io.IOException {
            out.write(b, off, len);
        }

        @Override
        public void close() {}
    }
}
