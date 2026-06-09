```cmd=
netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=8484 connectaddress=127.0.0.1 connectport=8383
netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=8484 
```