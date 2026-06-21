package com.hansode.roppou

/*
 * PlaybackService — Media3 の MediaSessionService。
 * ExoPlayer のプレイリストをネイティブが保持し、画面オフ・背景でも自動送りする（追加指示§2）。
 * foreground service（type=mediaPlayback）として通知つきで動くため、Doze でも再生継続。
 *
 * 配置先: android/app/src/main/java/com/hansode/roppou/PlaybackService.kt
 *   （npx cap add android で android/ 生成後にコピー。パッケージ名= appId と一致させる）
 */

import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService

class PlaybackService : MediaSessionService() {

    private var mediaSession: MediaSession? = null

    override fun onCreate() {
        super.onCreate()

        val player = ExoPlayer.Builder(this)
            .setAudioAttributes(
                // オーディオフォーカス（着信・他アプリ再生でダッキング/一時停止）を Media3 に任せる
                AudioAttributes.Builder()
                    .setUsage(C.USAGE_MEDIA)
                    .setContentType(C.AUDIO_CONTENT_TYPE_SPEECH)
                    .build(),
                /* handleAudioFocus = */ true
            )
            .setHandleAudioBecomingNoisy(true) // イヤホンを抜いたら一時停止
            .build()

        mediaSession = MediaSession.Builder(this, player).build()
    }

    // 通知の操作（再生/停止/次/前）から再生を続けるため、UIを閉じても止めない
    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = mediaSession

    override fun onDestroy() {
        mediaSession?.run {
            player.release()
            release()
        }
        mediaSession = null
        super.onDestroy()
    }
}
