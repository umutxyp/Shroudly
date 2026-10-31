package me.codeshare.shroudly

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class InstallSourceTest {
    @Test
    fun theGithubApkLooksForUpdatesOnGithub() {
        // Installed from a browser, a file manager, adb, or nothing recorded.
        assertTrue(InstallSource.githubUpdates(storeBuild = false, installer = null))
        assertTrue(InstallSource.githubUpdates(storeBuild = false, installer = "com.android.chrome"))
        assertTrue(InstallSource.githubUpdates(storeBuild = false, installer = "com.google.android.packageinstaller"))
        assertTrue(InstallSource.githubUpdates(storeBuild = false, installer = "com.android.shell"))
        // Another store is not Play: its copy is still the GitHub APK.
        assertTrue(InstallSource.githubUpdates(storeBuild = false, installer = "org.fdroid.fdroid"))
    }

    @Test
    fun aCopyPlayInstalledOrUpdatedNeverAsksGithub() {
        assertFalse(InstallSource.githubUpdates(storeBuild = false, installer = "com.android.vending"))
        assertFalse(InstallSource.githubUpdates(storeBuild = false, installer = InstallSource.PLAY_STORE))
    }

    @Test
    fun onlyThePlayBuildPlayInstalledIsUpdatedInsideTheApp() {
        assertTrue(InstallSource.playUpdates(storeBuild = true, installer = "com.android.vending"))
        // The bundle made for Play, put on the phone some other way (bundletool,
        // an APK mirror): Play would not answer for it.
        assertFalse(InstallSource.playUpdates(storeBuild = true, installer = null))
        assertFalse(InstallSource.playUpdates(storeBuild = true, installer = "com.android.chrome"))
        // The APK from GitHub has no Play library, even once Play updates it
        // (then it is Play's bundle, STORE_BUILD); the emulator's debug APK
        // installed as Play would (-i com.android.vending) neither.
        assertFalse(InstallSource.playUpdates(storeBuild = false, installer = "com.android.vending"))
        assertFalse(InstallSource.playUpdates(storeBuild = false, installer = null))
    }

    @Test
    fun thePlayBuildNeverAsksGithub() {
        assertFalse(InstallSource.githubUpdates(storeBuild = true, installer = null))
        assertFalse(InstallSource.githubUpdates(storeBuild = true, installer = "com.android.chrome"))
        assertFalse(InstallSource.githubUpdates(storeBuild = true, installer = "com.android.vending"))
    }
}
