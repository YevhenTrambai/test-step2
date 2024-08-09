pipeline {
    agent any

    stages {
        stage('Pull Code') {
            steps {
                checkout([$class: 'GitSCM', branches: [[name: 'main']], userRemoteConfigs: [[url: 'git@github.com:YevhenTrambai/test-step2.git', credentialsId: 'GIT_SSH_KEY']]])
            }
        }

        stage('Install Dependencies') {
            steps {
                sh 'npm install'
            }
        }

        stage('Build Docker Image') {
            steps {
                script {
                    docker.build('your-dockerhub-username/step2-test')
                }
            }
        }

        stage('Run Docker Container') {
            steps {
                script {
                    def app = docker.image('your-dockerhub-username/step2-test')
                    app.inside('--entrypoint="" -v /home/vagrant/opt/jenkins/workspace/Step2-test-pipeline:/app -w /app') {
                        sh 'npm test'
                    }
                }
            }
        }

        stage('Push to Docker Hub') {
            when {
                expression {
                    currentBuild.result == null || currentBuild.result == 'SUCCESS'
                }
            }
            steps {
                script {
                    withCredentials([string(credentialsId: 'docker_hub_token', variable: 'DOCKER_HUB_TOKEN')]) {
                        docker.withRegistry('https://index.docker.io/v1/', DOCKER_HUB_TOKEN) {
                            docker.image('yevhent/step2-test').push('latest')
                        }
                    }
                }
            }
        }
    }

    post {
        failure {
            echo 'Tests failed'
        }
    }
}
