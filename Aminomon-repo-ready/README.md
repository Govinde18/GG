# Aminomon for Android

This folder is a complete Android Studio project that wraps the offline web
version of Aminomon (the Python game runs inside the app through Pyodide).
No internet, no permissions, no ads. Progress is saved on the device.

**Not built or tested on a real phone yet.** The web version was tested in
Chromium; the Android wrapper has never been compiled. If the first build
shows an error, send it back and it will be fixed.

## Option A: build the APK with no PC (GitHub)
1. Create a free GitHub account and a new empty repository.
2. Upload everything in this folder (keep the `.github` folder).
3. Open the **Actions** tab, choose **Build Aminomon APK**, press **Run workflow**.
4. After a few minutes, open the finished run and download **Aminomon-apk**.
   Unzip it and install `app-debug.apk` on the phone (allow "install unknown apps").

## Option B: Android Studio (a PC or Mac)
1. Install Android Studio, choose **Open**, and pick this folder.
2. Let it sync (it downloads Gradle and the Android tools).
3. **Build > Build APK(s)**. The file is in `app/build/outputs/apk/debug/`.

## Publishing on Google Play
The debug APK is for installing directly. For Play you need a release build
signed with your own key:
1. Create a key: `keytool -genkey -v -keystore aminomon.jks -alias aminomon -keyalg RSA -keysize 2048 -validity 10000`
2. Make `keystore.properties` next to `settings.gradle` with
   `storeFile=aminomon.jks`, `storePassword=...`, `keyAlias=aminomon`, `keyPassword=...`
3. **Build > Generate Signed Bundle / APK** (choose Android App Bundle for Play).
Keep the key file safe: you need the same one for every update.

## Good to know
- Landscape is locked; the game needs a wide screen (80x24 characters or more).
- Needs Android 7+ with an up-to-date "Android System WebView" (updates through Play Store).
- First start takes a few seconds while Python loads.
- Menu button (top right) has text size, on-screen buttons, and **Back up save**.
- Update the game: rebuild the web files, copy them into `app/src/main/assets/www`, build again.
