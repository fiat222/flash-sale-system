## ผลลัพธ์การ read
docker run --rm  -v ${PWD}/loadtest:/loadtest -p 5665:5665 -e K6_WEB_DASHBOARD=true -e K6_WEB_DASHBOARD_EXPORT=/loadtest/report.html grafana/k6 run -e BASE_URL=http://172.30.58.10:8081 /loadtest/read.js

# สรุป


