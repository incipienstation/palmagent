import { generateKeyPairSync, createHash, sign } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { webauthn } from '../../../src/modules/auth/adapters/outbound/webauthn.js';
const settings={authEnabled:true,authOrigin:'https://example.com',rpId:'example.com',rpName:'Fixture',sessionTtlMs:60000};
const hash=(b:string | Buffer)=>createHash('sha256').update(b).digest();
const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
const jwk=publicKey.export({format:'jwk'});
const cose=Buffer.concat([Buffer.from('a5010203262001215820','hex'),Buffer.from(jwk.x!,'base64url'),Buffer.from('225820','hex'),Buffer.from(jwk.y!,'base64url')]);
const credential={credentialId:'YXVkaXQtY3JlZGVudGlhbA',publicKey:cose.toString('base64url'),counter:0,label:null,createdAt:0,lastUsedAt:0};
function assertion(challenge:string,origin=settings.authOrigin,flags=5){
 const data=Buffer.from(JSON.stringify({type:'webauthn.get',challenge,origin,crossOrigin:false}));
 const authData=Buffer.concat([hash(settings.rpId),Buffer.from([flags,0,0,0,1])]);
 return {id:credential.credentialId,rawId:credential.credentialId,type:'public-key' as const,clientExtensionResults:{},response:{clientDataJSON:data.toString('base64url'),authenticatorData:authData.toString('base64url'),signature:sign('sha256',Buffer.concat([authData,hash(data)]),privateKey).toString('base64url')}};
}
test('signed assertions require both user presence and user verification',async()=>{
 const options=await webauthn.authenticationOptions(settings);
 assert.equal(await webauthn.verifyAuthentication(settings,assertion(options.challenge),options.challenge,credential),1);
 await assert.rejects(webauthn.verifyAuthentication(settings,assertion(options.challenge,settings.authOrigin,1),options.challenge,credential), /user verification/i);
});
test('CONTROL wrong origin, wrong challenge, and missing user presence are rejected',async()=>{
 const options=await webauthn.authenticationOptions(settings);
 await assert.rejects(webauthn.verifyAuthentication(settings,assertion(options.challenge,'https://other.example'),options.challenge,credential));
 await assert.rejects(webauthn.verifyAuthentication(settings,assertion('wrong-challenge'),options.challenge,credential));
 await assert.rejects(webauthn.verifyAuthentication(settings,assertion(options.challenge,settings.authOrigin,0),options.challenge,credential));
});

test('registration rejects an otherwise valid attestation without user verification', async () => {
 const options = await webauthn.registrationOptions(settings, []);
 const id = Buffer.from(credential.credentialId, 'base64url');
 const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin: settings.authOrigin }));
 const registration = (flags: number) => {
  const authData = Buffer.concat([hash(settings.rpId), Buffer.from([flags, 0, 0, 0, 0]), Buffer.alloc(16), Buffer.from([0, id.length]), id, cose]);
  // CBOR {fmt: "none", attStmt: {}, authData: <bytes>}; the credential is generated above.
  const attestation = Buffer.concat([Buffer.from('a363666d74646e6f6e656761747453746d74a0686175746844617461', 'hex'), Buffer.from([0x58, authData.length]), authData]);
  return { id: credential.credentialId, rawId: credential.credentialId, type: 'public-key' as const, clientExtensionResults: {},
   response: { clientDataJSON: clientData.toString('base64url'), attestationObject: attestation.toString('base64url') } };
 };
 assert.equal((await webauthn.verifyRegistration(settings, registration(0x45), options.challenge))?.credentialId, credential.credentialId);
 await assert.rejects(webauthn.verifyRegistration(settings, registration(0x41), options.challenge), /user verification/i);
});
