#!/bin/bash

gzip_flags=--gzip-local=js,json,css,pbf,xlsx,svg,wasm,sqlite,mjs,map

gcloud storage buckets update gs://eatmydata-eu --web-main-page-suffix=index.html
gcloud storage buckets update gs://eatmydata-us --web-main-page-suffix=index.html

gcloud storage cp -r ${gzip_flags} ./dist/production/* gs://eatmydata-eu
gcloud storage cp -r ${gzip_flags} ./dist/production/* gs://eatmydata-us

gcloud compute url-maps invalidate-cdn-cache --async eatmydata-eu --path "/" --host="eatmydata.ai"
gcloud compute url-maps invalidate-cdn-cache --async eatmydata-us --path "/" --host="eatmydata.ai"

