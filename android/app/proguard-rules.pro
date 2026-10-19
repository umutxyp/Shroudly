# hev-socks5-tunnel finds this class by name in JNI_OnLoad and registers its
# natives on it; renaming or removing either breaks the tunnel.
-keep class me.codeshare.shroudly.Tun2Socks {
    *;
}
-keepclasseswithmembernames,includedescriptorclasses class * {
    native <methods>;
}
