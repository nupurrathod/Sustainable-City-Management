import os
import dill
import time
import atexit
import uvicorn
import sqlite3
import schedule
import argparse
import threading
import logging.config
import importlib.util
from typing import List
from etl_task import ETLTask
from datetime import datetime, timedelta
from fastapi import FastAPI, Query, Body
from etl_db_manager import ETLDataBaseManager
from utility import base64encode_obj, base64decode_obj

# Global variables.
DB_MANAGER = None
HOST = None
PORT = None
SCHEDULER_RUNNING = False
SCHEDULED_JOBS = {}

# Logger
logger = logging.getLogger("etl_pipeline")
def configure_logger(logs_dir):
    """ 
    Sets up the logger. 
    @param logs_dir: Path to directory within 
                          which logs are to be stored.
    """
    # Create logging directory if it does not already exist.
    if not os.path.exists(logs_dir):
        os.makedirs(logs_dir)

    # Configure logger.
    logging.config.dictConfig({
        "version": 1,
        "disable_existing_loggers": False, 
        "formatters": {
            "simple": {
                "format": "[%(asctime)s] %(levelname)s: %(message)s"
            },
            "detailed": {
                "format": "[%(levelname)s | %(module)s | L%(lineno)d] %(asctime)s: %(message)s",
                "datefmt": "%d-%m-%YT%H:%M:%S%z"
            }
        },
        "handlers": {
            "stderr": {
                "class": "logging.StreamHandler",
                "level": "WARNING",
                "formatter": "simple",
                "stream": "ext://sys.stderr"
            },
            "file": {
                "class": "logging.handlers.RotatingFileHandler",
                "level": "INFO",
                "formatter": "detailed",
                "filename": f"{logs_dir}/etl_pipeline.log",
                "maxBytes": 10000000,
                "backupCount": 3,
            },
            "queue_handler": {
                "class": "logging.handlers.QueueHandler",
                "handlers": ["stderr", "file"],
                "respect_handler_level": True
            }
        },
        "loggers": {
            "root": {"level": "DEBUG", "handlers": ["queue_handler"]}
        }
    })

    # Set up non-blocking logger on a separate thread.
    queue_handler = logging.getHandlerByName("queue_handler")
    if queue_handler is not None:
        queue_handler.listener.start() # Start this thread.
        atexit.register(queue_handler.listener.stop)

    print(
        "Logger 'etl_pipeline' was successfully set up.",
        f"Logs shall be saved at {logs_dir}"
    )

# Utility functions.
def run_scheduler():
    """ Runs the task scheduler on a separate thread than main. """
    while SCHEDULER_RUNNING == True:
        schedule.run_pending()
        time.sleep(1)  # Sleep time = 1 second.

def start_tasks():
    """
    Restarts periodic running of all saved tasks
    whose repeat time is overdue.
    """
    global SCHEDULER_RUNNING
    global SCHEDULED_JOBS
    global HOST
    global PORT
    print('Started existing scheduled tasks.')
    if SCHEDULER_RUNNING == False:
        start_scheduler()
    for task in DB_MANAGER.load_tasks(filters={'status':'scheduled'}):
        task.schedule(schedule=schedule, host=HOST, port=PORT)

# Initialize FastAPI app.
app = FastAPI()

# Create a task.
@app.post("/task/", summary="Create new ETL task.", description="Create a new ETL task, add it to the DB and schedule it.")
def create_task(task_str:str):
    """
    Creates a new ETL task, adds it to the DB and schedules it.
    @param task_str: Base64 encoded byte string of an ETL Task object.
    @return: Response to request.
    """
    response = {'status': 200, 'message': f'', 'data':[]}
    try:
        if SCHEDULER_RUNNING == False:
            start_scheduler()
        task = base64decode_obj(task_str) # Get ETL Task from base64 encoded string.
        DB_MANAGER.create_task(task) # Add task into DB.
        job = task.schedule(schedule=schedule, host=HOST, port=PORT) # Schedule task.
        SCHEDULED_JOBS[task.name] = job # Keep a reference of this scheduled job.
        response['message'] = f"Success. Task created and scheduled {task.name}."
    except Exception as e:
        delete_task(task.name) # Remove partially correct entered task.
        response['status'] = 400
        logger.error(f"Failure. Could not create task due to {e}.")
        response['message'] = f"Failure. Could not create task due to {e}."
    return response

@app.delete("/task/")
def delete_task(task_name: str):
    """
    Deletes a task with given name if it exists.
    @param task_name: Name of task to delete.
    """
    global DB_MANAGER
    global SCHEDULED_JOBS
    response = {'status': 200, 'message': f'', 'data':[]}
    try:
        stop_task(task_name)
        DB_MANAGER.delete_task(name=task_name)
        del(SCHEDULED_JOBS[task_name])
        print(f"Task {task_name} deleted.")
        response['status'] = 200
        response['message'] = f"Success. Task {task_name} deleted."
    except Exception as e:
        logger.error(f"Failure. Could not delete task {task_name} due to {e}.")
        response['status'] = 400
        response['message'] = f"Failure. Could not delete task {task_name} due to {e}."
    response["message"] = f"Success. Deleted task {task_name}."
    return response

@app.get("/task/")
def read_task(task_name:str, fields:str=''):
    """
    Get a task with given name if it exists.
    @param task_name: Name of task to delete.
    @param fields: Fields of data that is to be returned as a string
                   separated by spaces. By default, all fields are returned.
    @return: Response to request.
    """
    response = {'status': 200, 'message': f'', 'data':[]}
    if fields == '':
        fields = [
            "name", "fun_data_load", "fun_data_save",
            "repeat_time_unit", "repeat_interval", 
            "time_run_last_start", "time_run_last_end", 
            "num_runs", "status", "config"
        ]
    else:
        fields = fields.split(' ')
    try:
        task = DB_MANAGER.read_task(name=task_name, fields=fields)
        response["data"] = task
        response["message"] = f"Success. Retrieved task {task_name}."
    except Exception as e:
        logger.error(f"Failure. Could not get task {task_name} due to {e}.")
        response['status'] = 400
        response['message'] = f"Failure. Could not get task {task_name} due to {e}."
    return response

@app.get("/task/all/")
def read_all_tasks():
    """
    Get all tasks (name, status) currently in the DB.
    @return: Response to request.
    """
    response = {'status': 200, 'message': f'', 'data':[]}
    try:
        response["data"] = []
        for task in DB_MANAGER.load_tasks():
            response["data"].append({
                'name': task.name,
                'status': task.status,
                'num_runs': task.num_runs,
                'repeat_time_unit': task.repeat_time_unit,
                'repeat_interval': task.repeat_interval,
                'time_run_last_start': str(task.time_run_last_start),
                'time_run_last_end': str(task.time_run_last_end)
            })
        response["message"] = f"Success. Retrieved tasks."
    except Exception as e:
        logger.error(f"Failure. Could not get tasks due to {e}.")
        response['status'] = 400
        response['message'] = f"Failure. Could not get tasks due to {e}."
    return response

@app.put("/task/")
def update_task(task_name: str, new_values: dict):
    """
    Update status of a task in DB with given name 
    and stataus if it exists.
    @param task_name: Name of task to update.
    @param new_values:New values that should replace old ones.
                      Keys of this dictionary are field names
                      and values are new data for these fields.
    @return: Response to request.
    """
    response = {'status': 200, 'message': f'', 'data':[]}
    try:
        DB_MANAGER.update_task(name=task_name, new_values=new_values)
        response["message"] = f"Success. Status of task {task_name} updated with new values {new_values}."
    except Exception as e:
        logger.error(f"Failure. Could not update status of task {task_name} due to {e}.")
        response['status'] = 400
        response['message'] = f"Failure. Could not update status of task {task_name} due to {e}."
    return response

@app.put("/task/stop/")
def stop_task(task_name: str):
    """
    Stops a currently scheduled task.
    @param task_name: Name of task to stop.
    @return: Response to request.
    """
    global SCHEDULED_JOBS
    response = {'status': 200, 'message': f'', 'data':[]}
    try:
        if task_name in SCHEDULED_JOBS:
            schedule.cancel_job(job=SCHEDULED_JOBS[task_name])
            DB_MANAGER.update_task(name=task_name, new_values={'status': 'stopped'})
            print(f"Task {task_name} stopped.")
            response['message'] = 'Success. Task has been stopped.'
    except Exception as e:
        logger.error(f"Failure. Could not stop task {task_name} due to {e}.")
        print(f"Task {task_name} could not be stopped.")
        response['status'] = 400
        response['message'] = f"Failure. Could not stop task {task_name} due to {e}."
    response["message"] = f"Success. Task {task_name} has been stopped."
    return response

@app.get("/start_scheduler/")
def start_scheduler():
    """ Start the task scheduler thread. """
    global SCHEDULER_RUNNING
    response = {"status": 200, "message": "", "data":[]}
    try: # Start the scheduler in a separate thread.
        if SCHEDULER_RUNNING == True: 
            response["status"] = 200
            print('Scheduler is already running.')
            response['message'] = 'Scheduler is already running.'
        else:
            SCHEDULER_RUNNING = True
            threading.Thread(target=run_scheduler).start()
            start_tasks()
            print('Scheduler started.')
            response["status"] = 200
            response["message"] = f"Scheduler started."
    except Exception as e:
        response["message"] = f"Scheduler could not be started due to {e}."
        response["status"] = 400
        response["message"] = f"Scheduler could not be started due to {e}."
    return response

@app.get("/stop_scheduler/")
def stop_scheduler():
    """ Stop the task scheduler. """
    global SCHEDULER_RUNNING
    response = {"status": 200, "message": "", "data":[]}
    try: # Start the scheduler in a separate thread.
        if SCHEDULER_RUNNING == False:
            response["status"] = 200
            print("Scheduler is not running.")
            response["message"] = "Scheduler is not running."
        else:
            SCHEDULER_RUNNING = False
            response["status"] = 200
            print("Scheduler stopped.")
            response["message"] = "Scheduler stopped."
    except Exception as e:
        logger.log(f"Scheduler could not be stopped due to {e}.")
        response["status"] = 400
        response["message"] = f"Scheduler could not be stopped due to {e}."
    return response

@app.put("/task/start")
def start_task(task_name:str):
    """ 
    Pass in names of modules that need to be imported. 
    @param modules: List of strings of module names.
    """
    global SCHEDULED_JOBS
    global HOST
    global PORT
    response = {"status": 200, "message": ""}
    try:
        print('Started existing scheduled tasks.')
        if SCHEDULER_RUNNING == False:
            start_scheduler()
        for task in DB_MANAGER.load_tasks(filters={'name':task_name}):
            if task.status == 'stopped':
                task.schedule(schedule=schedule, host=HOST, port=PORT)
                response["message"] += f"Started task '{task_name}'. "
                print(f'Started task "{task_name}".')
        response['status'] = 200
    except Exception as e:
        logger.error(f"Failed to start task '{task_name}' due to {e}.")
        response['status'] = 400
        response["message"] = f"Failed to start task '{task_name}' due to {e}."
    return response

if __name__ == "__main__":
    # Received DB name and path as cmd arguments.
    parser = argparse.ArgumentParser(description='ETL Pipeline argument parser. Please input path to the data base containing ETLTask status and its name.')
    parser.add_argument('--db-name', type=str, required=True, help='Name of the data base.')
    parser.add_argument('--db-path', type=str, default='.', help='Path to the data base.')
    parser.add_argument('--host', type=str, default="127.0.0.1", help='Name of host where this app shall run.')
    parser.add_argument('--port', type=int, default=8003, help='Name of port where this app shall run.')
    parser.add_argument('--logs-dir', type=str, default="./logs", help='Path to directory within which logs shall be saved.')
    args = parser.parse_args()

    # Set up logger.
    configure_logger(args.logs_dir)

    # Set up ETL Tasks DB.
    HOST = args.host
    PORT = args.port
    DB_MANAGER = ETLDataBaseManager(db_name=args.db_name, db_path=args.db_path)

    uvicorn.run(app, host=args.host, port=args.port)