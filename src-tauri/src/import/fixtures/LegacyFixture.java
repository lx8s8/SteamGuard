import java.nio.file.*;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.util.*;
import java.util.zip.GZIPOutputStream;
import java.io.ByteArrayOutputStream;
import org.bouncycastle.crypto.*;
import org.bouncycastle.crypto.generators.PKCS5S2ParametersGenerator;
import org.bouncycastle.crypto.params.KeyParameter;
import org.bouncycastle.crypto.engines.BlowfishEngine;
import org.bouncycastle.crypto.paddings.*;
public class LegacyFixture {
  static byte[] ascii(String text) { return text.getBytes(StandardCharsets.UTF_8); }
  static String hex(byte[] data) { return HexFormat.of().withUpperCase().formatHex(data); }
  static byte[] join(byte[]... values) throws Exception { ByteArrayOutputStream s=new ByteArrayOutputStream(); for(byte[] v:values)s.write(v); return s.toByteArray(); }
  static byte[] encrypt(byte[] plain, String password, boolean header) throws Exception {
    byte[] salt=HexFormat.of().parseHex("0001020304050607");
    // The upstream .NET code calls GetBytes(256), not GetBytes(256 / 8).
    PKCS5S2ParametersGenerator kdf=new PKCS5S2ParametersGenerator();
    kdf.init(ascii(password),salt,2000);
    KeyParameter key=(KeyParameter)kdf.generateDerivedParameters(256*8);
    PaddedBufferedBlockCipher cipher=new PaddedBufferedBlockCipher(new BlowfishEngine(),new ISO10126d2Padding());
    SecureRandom rng=SecureRandom.getInstance("SHA1PRNG"); rng.setSeed(ascii("synthetic-fixture-only"));
    cipher.init(true,new org.bouncycastle.crypto.params.ParametersWithRandom(key,rng));
    byte[] out=new byte[cipher.getOutputSize(plain.length)];
    int n=cipher.processBytes(plain,0,plain.length,out,0); n+=cipher.doFinal(out,n);
    byte[] encrypted=join(salt,Arrays.copyOf(out,n));
    if(header) { byte[] outerSalt=HexFormat.of().parseHex("08090A0B0C0D0E0F"); byte[] hash=MessageDigest.getInstance("SHA-256").digest(join(outerSalt,plain)); encrypted=join(ascii("WINAUTH3"),outerSalt,hash,encrypted); }
    return encrypted;
  }
  public static void main(String[] args) throws Exception {
    Path directory=Path.of(args[0]); Files.createDirectories(directory);
    String record="<WinAuthAuthenticator type=\"WinAuth.GoogleAuthenticator\"><name>Fixture Ω</name><authenticatordata><secretdata>31323334353637383930</secretdata></authenticatordata></WinAuthAuthenticator>";
    String password="fixture-password-秘密";
    String xml="<?xml version=\"1.0\" encoding=\"utf-8\"?><config>"+record+"</config>";
    Files.writeString(directory.resolve("winauth-password.xml"),"<WinAuth version=\"3.3\"><data encrypted=\"y\">"+hex(encrypt(ascii(xml),password,true))+"</data></WinAuth>");
    String fragment="<?xml version=\"1.0\" encoding=\"utf-8\"?><authenticatordata><secretdata>31323334353637383930</secretdata></authenticatordata>";
    Files.writeString(directory.resolve("winauth-record-password.xml"),"<WinAuth><WinAuthAuthenticator type=\"WinAuth.GoogleAuthenticator\"><name>Per record</name><authenticatordata encrypted=\"y\">"+hex(encrypt(ascii(fragment),password,true))+"</authenticatordata></WinAuthAuthenticator></WinAuth>");
    Files.writeString(directory.resolve("winauth-v2-password.xml"),"<WinAuth><WinAuthAuthenticator><name>V2</name><authenticator type=\"WinAuth.GoogleAuthenticator\"><secretdata encrypted=\"y\">"+hex(encrypt(HexFormat.of().parseHex("31323334353637383930"),password,true))+"</secretdata></authenticator></WinAuthAuthenticator></WinAuth>");
    Files.writeString(directory.resolve("winauth-v2-unverified.xml"),"<WinAuth><WinAuthAuthenticator><name>V2</name><authenticator type=\"WinAuth.GoogleAuthenticator\"><secretdata encrypted=\"y\">"+hex(encrypt(HexFormat.of().parseHex("31323334353637383930"),password,false))+"</secretdata></authenticator></WinAuthAuthenticator></WinAuth>");
    ByteArrayOutputStream stream=new ByteArrayOutputStream(); try(GZIPOutputStream gzip=new GZIPOutputStream(stream)){gzip.write(ascii("<Auth>"+record+"</Auth>"));}
    Files.writeString(directory.resolve("watt-v1.dat.txt"),Base64.getEncoder().encodeToString(stream.toByteArray()));
  }
}
