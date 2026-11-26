"""Isolated preservation; no sports APIs, no production writes, no key output.

Only existing public aggregates and encrypted private members are downloaded.
Private decryption is streamed to /dev/null. Only the outer ciphertext and
non-sensitive verification metadata may leave the ephemeral runner.
Staging in the existing Actions artifact store is NOT independent backup.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import zipfile

E12 = [
    {"stage":"E12","run":45781862856,"id":15099020571,"name":"fdg2027-e12-aggregate","sha256":"f414d138dc14ba988b3ac1e142eafa8d56f5cf76e4b5b606a5cf17eea2817962"},
    {"stage":"E12","run":45781862856,"id":15097539957,"name":"fdg2027-e12-encrypted-certification","sha256":"bafeff43e8e83716f9b9bbc6cbde77e08a174d1ec13a23a9a94985468025c21b"},
]
def sha(p):
    with p.open("rb") as f:
        return hashlib.file_digest(f,"sha256").hexdigest()

def main():
    os.umask(0o077)
    out=Path(sys.argv[1]);out.mkdir(mode=0o700,parents=True,exist_ok=False)
    key=os.environ.pop("ARCHIVE_KEY", "")
    assert len(key)>=32 and "\n" not in key and "\r" not in key,"existing archive secret missing or invalid"
    password=(key+"\n").encode(); del key
    repo=os.environ["GH_REPO"]
    assert repo.lower()=="laerciorehem/formuladogol"
    lock=Path("research/fdg2027/e12/source-lock.json")
    data=json.loads(lock.read_text()); rows=data["artifacts"]+E12
    assert len(data["runs"])==12 and len(rows)==26 and len({r["id"] for r in rows})==26
    with tempfile.TemporaryDirectory(prefix="fdg-sl01-",dir=os.environ["RUNNER_TEMP"]) as t:
        work=Path(t); home=work/"gnupg";home.mkdir(mode=0o700)
        gpg=["gpg","--homedir",str(home),"--batch","--yes","--no-tty","--pinentry-mode","loopback"]
        def packet_aes(p):
            result=subprocess.run(gpg+["--list-only","--list-packets",str(p)],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
            return b"cipher 9" in result.stdout
        def decrypt_verify(p):
            result=subprocess.run(gpg+["--passphrase-fd","0","--decrypt",str(p)],input=password,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            assert result.returncode==0,"existing encrypted member cannot be restored with archive key"
        try:
            manifest=[]
            for row in rows:
                aid=int(row["id"])
                meta=json.loads(subprocess.check_output(["gh","api","--method","GET",f"repos/{repo}/actions/artifacts/{aid}"]))
                assert meta["id"]==aid and not meta["expired"]
                assert meta["digest"]=="sha256:"+row["sha256"]
                assert meta["workflow_run"]["id"]==row["run"]
                assert meta["name"]==row["name"]
                target=work/f"{aid}.zip"
                with target.open("xb") as f:
                    subprocess.run(["gh","api","--method","GET",f"repos/{repo}/actions/artifacts/{aid}/zip"],stdout=f,check=True)
                assert sha(target)==row["sha256"],f"ZIP digest mismatch: {aid}"
                private=("encrypted" in row["name"] or "private-audit" in row["name"])
                with zipfile.ZipFile(target) as z:
                    assert z.testzip() is None,f"CRC failure: {aid}"
                    names=z.namelist();cipher=[n for n in names if n.endswith(".gpg")]
                    if private:
                        assert len(names)==1 and len(cipher)==1,f"unexpected private ZIP layout: {aid}"
                        encrypted=work/"member.gpg"
                        with z.open(cipher[0]) as src, encrypted.open("xb") as dst:
                            import shutil
                            shutil.copyfileobj(src,dst)
                        try:
                            assert packet_aes(encrypted),f"not AES256: {aid}"
                            decrypt_verify(encrypted)
                        finally:
                            encrypted.unlink(missing_ok=True)
                    else:
                        assert not cipher,"unexpected unclassified encrypted content"
                manifest.append({"id":aid,"run":row["run"],"stage":row["stage"],"sha256":row["sha256"],
                                 "bytes":target.stat().st_size,"expires_at":meta["expires_at"],
                                 "crc_verified":True,"private_cipher_aes256_verified":private,
                                 "private_restore_verified":private})
                print(f"Artifact {aid}: ZIP SHA-256 and CRC verified; encrypted member restore {'verified' if private else 'n/a'}",flush=True)
            assert sum(x["private_restore_verified"] for x in manifest)==12
            mfile=work/"manifest.json"
            mfile.write_text(json.dumps(manifest,sort_keys=True,indent=2))
            bundle=work/"bundle.tar"
            # This temporary tar contains original ZIP ciphertext/public aggregates, never decrypted private records.
            with tarfile.open(bundle,"w") as tar:
                tar.add(lock,arcname="source-lock.json",recursive=False)
                tar.add(mfile,arcname="manifest.json",recursive=False)
                for row in manifest:
                    tar.add(work/f"{row['id']}.zip",arcname=f"{row['id']}.zip",recursive=False)
            expected={"source-lock.json":sha(lock),"manifest.json":sha(mfile)}
            expected.update({f"{x['id']}.zip":x["sha256"] for x in manifest})
            cipherfile=out/"fdg2027-sl01.tar.gpg"
            res=subprocess.run(gpg+["--passphrase-fd","0","--symmetric","--cipher-algo","AES256",
                                    "--compress-algo","none","--output",str(cipherfile),str(bundle)],
                               input=password,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            assert res.returncode==0 and packet_aes(cipherfile),"outer encryption failed"
            bundle.unlink()
            # Restore without writing a decrypted tar or any private plaintext to disk.
            restored={}
            proc=subprocess.Popen(gpg+["--passphrase-fd","0","--decrypt",str(cipherfile)],
                                  stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
            try:
                proc.stdin.write(password);proc.stdin.close()
                with tarfile.open(fileobj=proc.stdout,mode="r|") as tar:
                    for m in tar:
                        assert m.isfile() and m.name in expected and m.name not in restored
                        with tar.extractfile(m) as stream:
                            restored[m.name]=hashlib.file_digest(stream,"sha256").hexdigest()
                # Drain the stream to verify GPG integrity/MDC and avoid a broken pipe.
                while proc.stdout.read(65536): pass
                assert proc.wait()==0,"outer archive authentication failed"
            finally:
                if proc.poll() is None:
                    proc.kill();proc.wait()
            assert restored==expected,"outer restore member hashes mismatch"
            report={"scope":"temporary encrypted staging on existing GitHub Actions; not durable external backup",
                    "artifacts":manifest,"original_zips_verified":26,"private_members_aes256_verified":12,
                    "private_members_restored":12,"outer_encryption":"AES256",
                    "restored_zip_hashes":26,"restored_metadata_hashes":2,
                    "ciphertext_sha256":sha(cipherfile),"ciphertext_bytes":cipherfile.stat().st_size,
                    "private_plaintext_persisted":False,"external_destination_authorized":False,
                    "external_backup_verified":False,"production_write":False}
            (out/"verification.json").write_text(json.dumps(report,indent=2))
            print("SL01 preservation: 26/26 ZIP byte hashes; 12/12 encrypted member restoration; 26/26 restored ZIP hashes; AES256 staging verified.")
        finally:
            subprocess.run(["gpgconf","--homedir",str(home),"--kill","gpg-agent"],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
if __name__=="__main__":
    main()
