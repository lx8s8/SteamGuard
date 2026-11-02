// Synthetic fixture generator using the official MemoryPack source generator.
using MemoryPack;
using System.Security.Cryptography;
using System.Text;
using System.Buffers.Binary;
var root=args[0]; Directory.CreateDirectory(root);
var dto=new AuthenticatorExportDTO {Platform=AuthenticatorPlatform.Steam,Issuer="Steam",HMACType=HMACTypes.SHA1,Serial="serial-synthetic",DeviceId="android:fixture",SteamData="{\"steamid\":\"76561198000000001\",\"identity_secret\":\"aWRlbnRpdHk=\",\"account_name\":\"synthetic\"}",Counter=0,Period=30,SecretKey=Encoding.UTF8.GetBytes("12345678901234567890"),CodeDigits=5,Name="MemoryPack Ω"};
File.WriteAllBytes(Path.Combine(root,"memorypack-dto.bin"),MemoryPackSerializer.Serialize(dto));
File.WriteAllBytes(Path.Combine(root,"memorypack-dto-utf16.bin"),MemoryPackSerializer.Serialize(dto,MemoryPackSerializerOptions.Utf16));
var second=new AuthenticatorExportDTO {Platform=AuthenticatorPlatform.HOTP,Issuer="Example",HMACType=HMACTypes.SHA512,Counter=37,Period=45,SecretKey=Encoding.UTF8.GetBytes("1234567890"),CodeDigits=8,Name="HOTP test"};
File.WriteAllBytes(Path.Combine(root,"memorypack-dto-list.bin"),MemoryPackSerializer.Serialize(new[]{dto,second}));
// .mpo values remain MessagePack even when the outer account model uses MemoryPack.
// Explicitly encoded synthetic union [12,{SecretKey:bin,CodeDigits:6,Period:30,HMACType:0}].
var messagepack=Convert.FromHexString("920C84A95365637265744B6579C40A31323334353637383930AA436F646544696769747306A6506572696F641EA8484D41435479706500");
var account=new AccountPlatformAuthenticator{Index=1,Name=Encrypt(Encoding.UTF8.GetBytes("MemoryPack account")),Value=Encrypt(messagepack),IsNotLocal=true,IsNeedSecondaryPassword=false,Created=DateTimeOffset.UnixEpoch,LastUpdate=DateTimeOffset.UnixEpoch,ServerId=null};
File.WriteAllBytes(Path.Combine(root,"memorypack-accounts.bin"),MemoryPackSerializer.Serialize(new[]{account}));
File.WriteAllBytes(Path.Combine(root,"memorypack-account.bin"),MemoryPackSerializer.Serialize(account));
static byte[] Encrypt(byte[] plain) {
// The original publicly distributed compatibility resource; never a user secret.
byte[] parameters=Convert.FromHexString("0A007D855A1FB070C82AD2DB60A2C6BA0955B542C5D36FD47626B8A93E1C19EAC0476008F1BDC50555A34179BA53576BB387");
using var aes=Aes.Create();aes.Key=parameters.Skip(18).Reverse().ToArray();aes.IV=parameters.Skip(2).Take(16).ToArray();var cipher=aes.EncryptCbc(plain,aes.IV,PaddingMode.PKCS7);var output=new byte[cipher.Length+8];BinaryPrimitives.WriteUInt32LittleEndian(output,1);cipher.CopyTo(output,8);return output;}
public enum AuthenticatorPlatform:byte {Steam=1,Microsoft=5,BattleNet=11,Google=12,HOTP=13,TOTP=14}
public enum HMACTypes {SHA1=0,SHA256=1,SHA512=2}
[MemoryPackable(SerializeLayout.Explicit)]
public sealed partial class AuthenticatorExportDTO {
 [MemoryPackOrder(0)] public AuthenticatorPlatform Platform {get;set;}
 [MemoryPackOrder(1)] public string? Issuer {get;set;}
 [MemoryPackOrder(2)] public HMACTypes HMACType {get;set;}
 [MemoryPackOrder(3)] public string? Serial {get;set;}
 [MemoryPackOrder(4)] public string? DeviceId {get;set;}
 [MemoryPackOrder(5)] public string? SteamData {get;set;}
 [MemoryPackOrder(6)] public long Counter {get;set;}
 [MemoryPackOrder(7)] public int Period {get;set;}
 [MemoryPackOrder(8)] public byte[]? SecretKey {get;set;}
 [MemoryPackOrder(9)] public int CodeDigits {get;set;}
 [MemoryPackOrder(10)] public string Name {get;set;}="";
}
[MemoryPackable]
public sealed partial class AccountPlatformAuthenticator {
 [MemoryPackIgnore] public ushort Id {get;set;}
 public int Index {get;set;}
 public byte[]? Name {get;set;}
 public byte[]? Value {get;set;}
 public bool IsNotLocal {get;set;}
 public bool IsNeedSecondaryPassword {get;set;}
 public DateTimeOffset Created {get;set;}
 public DateTimeOffset LastUpdate {get;set;}
 public Guid? ServerId {get;set;}
}
