package es.dhtrails.app;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

// The gates said out loud while recording (Grabar, voice.mjs): Android's own text-to-speech, which a web
// page in the app cannot reach. It speaks with the screen off too, through headphones or the speaker, as
// navigation guidance: music playing is lowered while it speaks and comes back after.
@CapacitorPlugin(name = "Speech")
public class SpeechPlugin extends Plugin implements TextToSpeech.OnInitListener {
    private static final AudioAttributes GUIDANCE = new AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build();
    private TextToSpeech tts;
    private boolean ready;
    private final List<String[]> waiting = new ArrayList<>();   // said once the voice is ready
    private AudioManager audio;
    private AudioFocusRequest focus;

    @Override
    public void load() {
        audio = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        if (Build.VERSION.SDK_INT >= 26) {
            focus = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK).setAudioAttributes(GUIDANCE).build();
        }
        tts = new TextToSpeech(getContext(), this);
    }

    @Override
    public void onInit(int status) {
        ready = status == TextToSpeech.SUCCESS;
        if (ready) {
            tts.setAudioAttributes(GUIDANCE);
            tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override
                public void onStart(String id) {}

                @Override
                public void onDone(String id) {
                    release();
                }

                @Override
                public void onError(String id) {
                    release();
                }
            });
            for (String[] w : waiting) say(w[0], w[1]);
        }
        waiting.clear();
    }

    private void say(String text, String lang) {
        tts.setLanguage(Locale.forLanguageTag(lang));
        if (Build.VERSION.SDK_INT >= 26 && focus != null) audio.requestAudioFocus(focus);
        tts.speak(text, TextToSpeech.QUEUE_ADD, null, "dhtrails" + System.nanoTime());
    }

    // The music comes back once nothing is left to say.
    private void release() {
        if (Build.VERSION.SDK_INT >= 26 && focus != null && !tts.isSpeaking()) audio.abandonAudioFocusRequest(focus);
    }

    @PluginMethod
    public void speak(PluginCall call) {
        String text = call.getString("text"), lang = call.getString("lang", "es-ES");
        if (text == null || text.isEmpty()) {
            call.reject("nothing to say");
            return;
        }
        if (ready) say(text, lang);
        else if (tts != null) waiting.add(new String[] {text, lang});
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        if (tts != null) tts.shutdown();
    }
}
