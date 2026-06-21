package com.hansode.roppou;

/*
 * 配置先: android/app/src/main/java/com/hansode/roppou/MainActivity.java
 * （npx cap add android が生成する MainActivity を、この内容で置き換える）
 *
 * ローカル自作プラグインは super.onCreate より前に registerPlugin で登録する。
 */

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(RoppouPlaybackPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
