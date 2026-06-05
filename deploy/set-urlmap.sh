#!/bin/bash

gcloud compute url-maps import eatmydata-eu --source=deploy/urlmap-eu.yaml

gcloud compute url-maps import eatmydata-us --source=deploy/urlmap-us.yaml