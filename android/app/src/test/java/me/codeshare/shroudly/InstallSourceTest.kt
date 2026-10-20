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
    fun thePlayBuildNeverAsksGithub() {
        assertFalse(InstallSource.githubUpdates(storeBuild = true, installer = null))
        assertFalse(InstallSource.githubUpdates(storeBuild = true, installer = "com.android.chrome"))
        assertFalse(InstallSource.githubUpdates(storeBuild = true, installer = "com.android.vending"))
    }
}
