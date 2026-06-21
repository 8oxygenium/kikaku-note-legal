package com.hansode.roppou

/*
 * RoppouPlaybackPlugin — Web層(playback.js の native バックエンド)とネイティブ再生をつなぐ。
 *
 * 役割:
 *  - setQueue / append : Web が作ったシャッフル済みキューを MediaItem 列にして ExoPlayer に渡す。
 *  - playPause/next/previous/stop/setRate : 通知/JSどちらからでも操作。
 *  - 自動送りはネイティブ所有（onMediaItemTransition）。JS の onComplete に依存しない（§2）。
 *  - ネイティブ→Web イベント: trackChanged / queueLow / stateChanged を notifyListeners で送る。
 *
 * 配置先: android/app/src/main/java/com/hansode/roppou/RoppouPlaybackPlugin.kt
 * 登録: MainActivity.onCreate で registerPlugin(RoppouPlaybackPlugin::class.java)
 */

import android.content.ComponentName
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.MoreExecutors

private const val ARTIST_CREDIT = "VOICEVOX：春日部つむぎ" // ロック画面表示が常時クレジットを兼ねる(§6)
private const val QUEUE_LOW_THRESHOLD = 10

@CapacitorPlugin(name = "RoppouPlayback")
class RoppouPlaybackPlugin : Plugin() {

    private var controllerFuture: ListenableFuture<MediaController>? = null
    private var controller: MediaController? = null

    override fun load() {
        val token = SessionToken(context, ComponentName(context, PlaybackService::class.java))
        val future = MediaController.Builder(context, token).buildAsync()
        controllerFuture = future
        future.addListener({
            controller = future.get()
            controller?.addListener(playerListener)
        }, MoreExecutors.directExecutor())
    }

    private val playerListener = object : Player.Listener {
        override fun onMediaItemTransition(item: MediaItem?, reason: Int) {
            val c = controller ?: return
            emitTrackChanged(c.currentMediaItemIndex, item?.mediaId)
            val remaining = c.mediaItemCount - c.currentMediaItemIndex - 1
            if (remaining <= QUEUE_LOW_THRESHOLD) {
                notifyListeners("queueLow", JSObject().put("remaining", remaining))
            }
        }
        override fun onIsPlayingChanged(isPlaying: Boolean) {
            notifyListeners("stateChanged", JSObject().put("playing", isPlaying))
        }
    }

    private fun emitTrackChanged(index: Int, id: String?) {
        notifyListeners("trackChanged", JSObject().put("index", index).put("id", id ?: ""))
    }

    /* ---- JS items -> MediaItem ---- */
    private fun toMediaItems(call: PluginCall): List<MediaItem> {
        val arr = call.getArray("items") ?: return emptyList()
        val list = ArrayList<MediaItem>()
        for (i in 0 until arr.length()) {
            val o = arr.getJSONObject(i)
            val id = o.optString("id")
            val lawName = o.optString("lawName")
            val articleNo = o.optString("articleNo")
            // mp3Uri は "./audio/{lawId}/{id}.mp3" 相対。Capacitor が public/ を assets にコピーするので asset:// へ。
            val rel = o.optString("mp3Uri").removePrefix("./").removePrefix("/")
            val uri = "asset:///public/$rel"
            val meta = MediaMetadata.Builder()
                .setTitle("$lawName $articleNo")
                .setArtist(ARTIST_CREDIT)
                .build()
            list.add(
                MediaItem.Builder()
                    .setMediaId(id)
                    .setUri(uri)
                    .setMediaMetadata(meta)
                    .build()
            )
        }
        return list
    }

    @PluginMethod
    fun setQueue(call: PluginCall) {
        val items = toMediaItems(call)
        runOnMain {
            val c = controller ?: return@runOnMain call.reject("controller not ready")
            c.setMediaItems(items)
            c.prepare()
            c.play()
            call.resolve()
        }
    }

    @PluginMethod
    fun append(call: PluginCall) {
        val items = toMediaItems(call)
        runOnMain {
            controller?.addMediaItems(items)
            call.resolve()
        }
    }

    @PluginMethod
    fun playPause(call: PluginCall) = runOnMain {
        val c = controller ?: return@runOnMain call.reject("controller not ready")
        if (c.isPlaying) c.pause() else c.play()
        call.resolve()
    }

    @PluginMethod
    fun next(call: PluginCall) = runOnMain {
        controller?.let { if (it.hasNextMediaItem()) it.seekToNextMediaItem() }
        call.resolve()
    }

    @PluginMethod
    fun previous(call: PluginCall) = runOnMain {
        controller?.let { if (it.hasPreviousMediaItem()) it.seekToPreviousMediaItem() }
        call.resolve()
    }

    @PluginMethod
    fun stop(call: PluginCall) = runOnMain {
        controller?.pause()
        call.resolve()
    }

    @PluginMethod
    fun setRate(call: PluginCall) {
        val rate = call.getFloat("rate") ?: 1.0f
        runOnMain {
            controller?.playbackParameters = PlaybackParameters(rate)
            call.resolve()
        }
    }

    private fun runOnMain(block: () -> Unit) {
        activity?.runOnUiThread(block) ?: block()
    }

    override fun handleOnDestroy() {
        controller?.release()
        controllerFuture?.let { MediaController.releaseFuture(it) }
        super.handleOnDestroy()
    }
}
